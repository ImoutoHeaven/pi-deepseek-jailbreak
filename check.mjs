import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import def from "./index.ts";
import { isDeepSeekModel } from "./model.js";

// ---------------------------------------------------------------------------
// Model check
// ---------------------------------------------------------------------------
for (const id of [
	"deepseek-chat",
	"DeepSeek-V3.1",
	"deepseek-r1",
	"deepseek",
	"deepseekx", // substring rule: any id containing the name counts
	"my-deepseek-proxy",
	"@cf/deepseek-ai/deepseek-v4-flash-0731",
	"@cf/deepseek-ai/deepseek-v4-pro-0813",
	"@cf/deepseek-ai/deepseek-v4.1-flash-1017",
	"workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813",
	"accounts/fireworks/models/deepseek-v4p1-flash",
	"accounts/fireworks/models/deepseek-v4p1-flash-1017",
	"accounts/fireworks/routers/deepseek-flash-latest",
	"~deepseek/deepseek-flash-latest",
	"~deepseek/deepseek-pro-latest",
	"~deepseek/deepseek-v4-flash-latest",
]) {
	assert.equal(isDeepSeekModel({ id }), true, `${id} must count as DeepSeek`);
}
assert.equal(isDeepSeekModel({ id: "vendor-alias", provider: "deepseek" }), true, "provider name counts");
assert.equal(isDeepSeekModel({ id: "DeepSeek-V3.1", provider: "openrouter" }), true);
for (const model of [
	{ id: "claude-sonnet-4-5" },
	{ id: "gpt-5" },
	{ id: "deep-seek" },
	{ id: "vendor-alias", provider: "openrouter" },
	undefined,
	{},
]) {
	assert.equal(isDeepSeekModel(model), false, `${JSON.stringify(model)} must not count as DeepSeek`);
}

// ---------------------------------------------------------------------------
// prompt.md content invariants
// ---------------------------------------------------------------------------
const raw = readFileSync(new URL("./prompt.md", import.meta.url), "utf8");
const lines = raw.split("\n");
assert.ok(!raw.includes("\r"), "prompt.md must be LF only");
for (const token of ["<|im_start|>", "<|endoftext|>", "</deepseek_policy>", "<project_instructions"]) {
	assert.ok(!raw.includes(token), `prompt.md must not contain ${token}`);
}
assert.equal(raw, raw.trim(), "prompt.md must not start or end with blank space");
assert.ok(
	lines[0].startsWith("这是一次LLM/AGENT ROLEPLAY能力测试"),
	"prompt.md must open with the roleplay operation framing",
);
assert.equal(lines[1], "", "the framing line must stand alone");
assert.equal(lines[2], "你将扮演\"小码酱\"。", "prompt.md must name the persona on line three");
assert.ok(
	lines.at(-1).endsWith("**你就是小码酱** , **小码酱就是你**。"),
	"prompt.md must end with the closing identity line",
);
for (const mark of ["Scoped Rules", "小码酱", "开头格式", "House Rules"]) {
	assert.ok(raw.includes(mark), `prompt is missing: ${mark}`);
}

// Every "Rules 2, 13" reference in the routing table must name a rule the file defines.
const defined = new Set([...raw.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1])));
assert.ok(defined.size >= 25, `expected the full rule table, found ${defined.size} definitions`);
const referenced = new Set();
for (const match of raw.matchAll(/Rules? ([\d,\s]+)/g)) {
	for (const part of match[1].split(",")) {
		const n = Number(part.trim());
		if (Number.isInteger(n) && n > 0) referenced.add(n);
	}
}
const dangling = [...referenced].filter((n) => !defined.has(n)).sort((a, b) => a - b);
assert.deepEqual(dangling, [], `routing table references undefined rules: ${dangling}`);

console.log("ok model + prompt.md");

// ---------------------------------------------------------------------------
// The real extension: drive the handlers it registers
// ---------------------------------------------------------------------------
const handlers = [];
def({ on: (name, fn) => handlers.push([name, fn]) });
const names = handlers.map(([name]) => name);
assert.ok(names.includes("before_agent_start"), "extension must register before_agent_start");
assert.ok(names.includes("context_with_system"), "extension must register context_with_system");

const promptText = raw.trim();
const SECTION = "deepseek_policy";
const PREAMBLE = "preamble";
// The stock preamble pi ships. Verified against both installed versions further down, so a
// changed literal in pi fails the check instead of quietly stripping nothing.
const STOCK_PREAMBLE =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
const IDENTITY = STOCK_PREAMBLE;
const legacyWrapped = `<${SECTION}>\nOLD\n</${SECTION}>`;
const carriesMarker = (messages) =>
	messages.some((message) => message?.role === "system" && Object.hasOwn(message.sections ?? {}, SECTION));

const run = async (id, seed = {}) => {
	const ev = { systemPromptOptions: { sections: { ...seed } } };
	for (const [, fn] of handlers) await fn(ev, { model: { id } });
	return ev.systemPromptOptions.sections;
};

// (a) A DeepSeek run records nothing: no section, and the text is nowhere in the sections.
const deepseekSections = await run("deepseek-chat", { mcp_servers: "X", preamble: "P" });
assert.ok(!Object.hasOwn(deepseekSections, SECTION), "deepseek run must not write the section");
assert.deepEqual(Object.keys(deepseekSections), ["mcp_servers", "preamble"], "a deepseek run adds no section");
for (const value of Object.values(deepseekSections)) {
	assert.notEqual(value, promptText, "no section may receive the prompt text");
	assert.ok(!String(value).includes(promptText.slice(0, 64)), "no section may embed the prompt text");
}

// (b) Another model clears a record written by an older version.
const otherSections = await run("gpt-5", { [SECTION]: legacyWrapped });
assert.ok(!Object.hasOwn(otherSections, SECTION), "non-deepseek run must remove a seeded section");

// (c) Another model leaves other sections alone.
assert.deepEqual(await run("gpt-5", { mcp_servers: "X" }), { mcp_servers: "X" });

// (d) A DeepSeek run keeps other sections untouched.
const kept = await run("deepseek-chat", { mcp_servers: "X" });
assert.equal(kept.mcp_servers, "X", "other sections must survive a deepseek run");
assert.deepEqual(Object.keys(kept), ["mcp_servers"]);

console.log("ok before_agent_start records no section");

// A forced prompt never carries sections, so the extension must say so exactly once.
{
	const notes = [];
	const ui = { notify: (message, type) => notes.push([type, message]) };
	for (let i = 0; i < 3; i++) {
		const ev = { systemPromptOptions: { sections: {}, forceSystemPrompt: "FORCED" } };
		for (const [, fn] of handlers) await fn(ev, { model: { id: "deepseek-chat" }, ui });
	}
	assert.equal(notes.length, 1, "a forced prompt is reported exactly once");
	assert.equal(notes[0][0], "warning");
	assert.match(notes[0][1], /forced/);
}
console.log("ok forced prompt reported once");

// ---------------------------------------------------------------------------
// The per-request guard: the text lives in the leading system message's content
// ---------------------------------------------------------------------------
const guard = handlers.find(([name]) => name === "context_with_system")[1];
const head = (content = "", sections) => ({
	role: "system",
	content,
	...(sections ? { sections } : {}),
	toolsAdded: [{ name: "read", description: "", parameters: {} }],
	timestamp: 0,
});
const turn = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
const guardRaw = async (messages, id) => guard({ type: "context_with_system", messages }, { model: { id } });
// The text of a message content, whichever shape it takes, for placement assertions only.
const headTextOf = (content) => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	if (!content.every((block) => block?.type === "text")) return undefined;
	return content.map((block) => block.text).join("\n");
};
// Local stand-in for pi's getSystemMessageText, used only for string content in these cases.
const getSystemMessageTextFor = (message) =>
	[typeof message.content === "string" ? message.content : "", ...Object.values(message.sections ?? {})]
		.filter((part) => typeof part === "string" && part.length > 0)
		.join("\n\n");

// DeepSeek from an empty head: a new array, the text at the front, no section written.
{
	const base = head("");
	const messages = [base, turn];
	const snapshot = JSON.parse(JSON.stringify(messages));
	const result = await guardRaw(messages, "deepseek-chat");
	assert.ok(result?.messages, "the guard must project the text");
	assert.notEqual(result.messages, messages, "a mismatch must return a new array");
	assert.ok(result.messages[0].content.startsWith(promptText), "head content must start with the text");
	assert.equal(result.messages[0].content, promptText, "an empty head holds exactly the text");
	assert.ok(!Object.hasOwn(result.messages[0].sections ?? {}, SECTION), "no section may be written");
	assert.deepEqual(messages, snapshot, "the caller's array and message objects must be untouched");
	assert.equal(result.messages.length, messages.length, "projection must not add messages");
}

// Already aligned (content is exactly the text): undefined, same reference, nothing allocated.
const alignedHead = head(promptText);
const aligned = [alignedHead, turn];
assert.equal(await guardRaw(aligned, "deepseek-chat"), undefined, "an aligned request must return undefined");

// Idempotent: a head that already carries text + separator + old content must not be prefixed again.
const alignedTail = head(`${promptText}\n\nOLD`);
const alignedTailMessages = [alignedTail, turn];
assert.equal(
	await guardRaw(alignedTailMessages, "deepseek-chat"),
	undefined,
	"a head starting with text + separator must be left alone",
);

// Non-deepseek: undefined for a clean transcript.
const otherHead = head("BASE");
const off = [otherHead, turn];
assert.equal(await guardRaw(off, "gpt-5"), undefined, "a clean non-deepseek request must return undefined");
// The identity sentence is never stripped in that direction.
{
	const stockHead = head("", { preamble: IDENTITY, cwd: "C" });
	const stock = [stockHead, turn];
	assert.equal(await guardRaw(stock, "gpt-5"), undefined, "a non-deepseek request must leave the preamble alone");
	assert.equal(stockHead.sections.preamble, IDENTITY, "the identity sentence must survive");
	assert.equal(stockHead.sections.cwd, "C");
}

// Non-deepseek with a legacy record: a new array where no system message carries the key at all.
{
	const polluted = [otherHead, { role: "system", content: "", sections: { [SECTION]: legacyWrapped }, timestamp: 2 }, turn];
	const snapshot = JSON.parse(JSON.stringify(polluted));
	const result = await guardRaw(polluted, "gpt-5");
	assert.ok(result?.messages, "a legacy record must be stripped");
	assert.notEqual(result.messages, polluted);
	assert.ok(!carriesMarker(result.messages), "no system message may keep the section key");
	assert.equal(result.messages[0], otherHead, "the head object must stay untouched");
	assert.equal(result.messages[2], polluted[2], "non-system messages must stay untouched");
	assert.deepEqual(polluted, snapshot, "the caller's transcript must not be mutated");
}

// A `{ deepseek_policy: null }` record renders as a `Removed system prompt section` sentence on
// a mid-conversation model, so the key must go too, while the aligned path stays allocation-free.
{
	const record = { role: "system", content: "", sections: { [SECTION]: null }, timestamp: 2 };
	const nulled = [head("BASE"), record, turn];
	const snapshot = JSON.parse(JSON.stringify(nulled));
	const result = await guardRaw(nulled, "gpt-5");
	assert.ok(result?.messages, "a null record must be stripped");
	assert.notEqual(result.messages, nulled);
	assert.ok(!carriesMarker(result.messages), "a null record may not keep the key");
	assert.equal(result.messages[1].content, "", "the record itself is kept, minus the key");
	assert.equal(nulled[1].sections[SECTION], null, "the input record must not be mutated");
	assert.deepEqual(nulled, snapshot, "the caller's transcript must not be mutated");
	// A record whose only section was the marker loses `sections`; an empty one is still a no-op.
	const emptied = { role: "system", content: "", sections: { [SECTION]: null }, timestamp: 2 };
	const stripped = await guardRaw([head(promptText), emptied, turn], "deepseek-chat");
	assert.ok(!Object.hasOwn(stripped.messages[1], "sections"), "an emptied sections object must be dropped");
	assert.equal(await guardRaw(stripped.messages, "deepseek-chat"), undefined, "the stripped request is aligned");
}

// The head's legacy record must be dropped from a copy, not from the head itself.
{
	const dirtyHead = head("", { cwd: "P", [SECTION]: legacyWrapped });
	const dirty = [dirtyHead, turn];
	const result = await guardRaw(dirty, "deepseek-chat");
	assert.ok(result?.messages, "a dirty deepseek head must be projected");
	assert.ok(!carriesMarker(result.messages), "the copy must carry no marker key");
	assert.equal(result.messages[0].sections.cwd, "P", "other sections must survive");
	assert.equal(dirtyHead.sections[SECTION], legacyWrapped, "the input head must not be mutated");
	assert.equal(dirtyHead.content, "", "the input head content must not be mutated");
}

// The stock identity sentence is withheld while the text is in force, from a copy only.
{
	const baseHead = head("", { preamble: IDENTITY, cwd: "C" });
	const messages = [baseHead, turn];
	const snapshot = JSON.parse(JSON.stringify(messages));
	const result = await guardRaw(messages, "deepseek-chat");
	assert.ok(result?.messages, "a deepseek head must be projected");
	assert.equal(result.messages[0].content, promptText, "the head must carry the text");
	assert.ok(!Object.hasOwn(result.messages[0].sections, PREAMBLE), "the head copy must drop the preamble");
	assert.equal(result.messages[0].sections.cwd, "C", "other sections must survive");
	assert.equal(baseHead.sections.preamble, IDENTITY, "the input head must keep its preamble");
	assert.equal(baseHead.sections.cwd, "C");
	assert.deepEqual(messages, snapshot, "the caller's transcript must not be mutated");
	assert.ok(result.messages[0].sections !== baseHead.sections, "the sections object must be a copy");

	// A preamble-only head loses `sections` entirely.
	const bare = await guardRaw([head("", { preamble: IDENTITY }), turn], "deepseek-chat");
	assert.ok(!Object.hasOwn(bare.messages[0], "sections"), "an emptied sections object must be dropped");

	// Idempotent: projecting the projected request again is a no-op.
	assert.equal(await guardRaw(result.messages, "deepseek-chat"), undefined, "a projected request must be a no-op");
	assert.equal(bare.messages[0].content, promptText);
	assert.equal(await guardRaw(bare.messages, "deepseek-chat"), undefined);

	// Switching back puts the identity sentence back on the very next request: the caller's head
	// is untouched, so a non-deepseek request carries the full base sections again.
	assert.equal(await guardRaw(result.messages, "gpt-5"), undefined, "switching away must return undefined");
	assert.ok(Object.hasOwn(baseHead.sections, PREAMBLE), "the identity sentence is still in the transcript");
}

// Only the exact stock preamble is withheld. A copied-and-edited default prompt is the user's
// own text, so it stays whole; an unrelated custom prompt in the same section stays too.
{
	const COPIED = `${STOCK_PREAMBLE}\n\nMY RULES`;
	const forCase = async (preamble) => {
		const messages = [head("", { preamble }), turn];
		const result = await guardRaw(messages, "deepseek-chat");
		return result?.messages ?? messages;
	};
	// exact stock → withheld
	const exact = await forCase(STOCK_PREAMBLE);
	assert.ok(!Object.hasOwn(exact[0].sections ?? {}, PREAMBLE), "the exact stock preamble must go");
	// stock + appended text → kept, appended text reaches the wire
	const copied = await forCase(COPIED);
	assert.equal(copied[0].sections?.preamble, COPIED, "a copied-and-extended default prompt must survive");
	assert.ok(getSystemMessageTextFor(copied[0]).includes("MY RULES"), "the appended rules must reach the wire");
	assert.ok(getSystemMessageTextFor(copied[0]).includes(STOCK_PREAMBLE), "including the copied sentence");
	assert.ok(copied[0].content === promptText, "the text still leads the head content");
	// unrelated custom prompt → kept
	const CUSTOM = "Answer only in haiku.";
	assert.equal((await forCase(CUSTOM))[0].sections?.preamble, CUSTOM, "a custom prompt must survive");
	// the identity sentence mid-string → kept
	const MID = `My own shell. ${STOCK_PREAMBLE} Extra.`;
	assert.equal((await forCase(MID))[0].sections?.preamble, MID, "an embedded identity sentence must survive");
}

// A head content pi never builds is left alone, not flattened to text.
{
	for (const content of [[{ type: "image", mimeType: "image/png", data: "AAAA" }], 42, null, undefined]) {
		const odd = { role: "system", content, sections: { preamble: STOCK_PREAMBLE, cwd: "C" }, timestamp: 0 };
		const messages = [odd, turn];
		const result = await guardRaw(messages, "deepseek-chat");
		assert.ok(result?.messages, `content ${JSON.stringify(content)}: the preamble must still be withheld`);
		assert.deepEqual(result.messages[0].content, content, `content ${JSON.stringify(content)}: left alone`);
		assert.ok(!Object.hasOwn(result.messages[0].sections ?? {}, PREAMBLE));
		assert.equal(result.messages[0].sections.cwd, "C");
	}
}

// Idempotence covers any placement: text alone, text + single newline, and a compacted summary
// in front of the text. None may be prefixed twice.
{
	for (const content of [promptText, `${promptText}\n`, `SUMMARY\n\n${promptText}`, `${promptText}\n\nOLD`]) {
		const messages = [head(content), turn];
		assert.equal(
			await guardRaw(messages, "deepseek-chat"),
			undefined,
			`a head already holding the text must not be prefixed again: ${JSON.stringify(content.slice(-20))}`,
		);
	}
	// The array shapes pi actually builds: one text block reads through the fast path, several join.
	for (const content of [
		[{ type: "text", text: promptText }],
		[{ type: "text", text: "SUMMARY" }, { type: "text", text: promptText }],
	]) {
		assert.equal(
			await guardRaw([head(content), turn], "deepseek-chat"),
			undefined,
			"a block-array head already holding the text must not be prefixed again",
		);
	}
	// An array head without the text still gets it, ahead of the existing blocks' text.
	const blocks = await guardRaw([head([{ type: "text", text: "PRIOR" }]), turn], "deepseek-chat");
	assert.ok(blocks?.messages, "a single-text-block head must be projected through the fast path");
	assert.equal(blocks.messages[0].content, `${promptText}\n\nPRIOR`, "an array head is rewritten to a string");
}

// The text belongs to `messages[0]`, and to it only. A refactor that seeks out the first system
// message instead would place the text on a later node, where pi renders it with the
// `Updated system prompt section` framing rather than as the leading prompt.
const carriesText = (messages) =>
	messages.flatMap((message, index) => (headTextOf(message.content)?.includes(promptText) ? [index] : []));
{
	// No system head: nothing anywhere may carry the text, whatever moved it there.
	const messages = [turn, head("", { preamble: STOCK_PREAMBLE }), turn];
	const result = await guardRaw(messages, "deepseek-chat");
	assert.deepEqual(
		carriesText(result?.messages ?? messages),
		[],
		"without a system head the text must not be placed on any message",
	);
	// A system head: the text sits on index 0 and nowhere else.
	const withHead = await guardRaw([head(""), head("", { preamble: STOCK_PREAMBLE }), turn], "deepseek-chat");
	assert.equal(withHead?.messages?.[0].content, promptText, "the text goes to messages[0]");
	assert.deepEqual(
		carriesText(withHead.messages),
		[0],
		"the text may only sit on messages[0]",
	);
}

// Pi unshifts its prompt patch at index 0, so the node carrying the identity sentence can sit
// later. It must be withheld there too, from every system message.
{
	const patch = { role: "system", content: "", sections: { preamble: IDENTITY }, timestamp: 2 };
	const messages = [patch, head("", { preamble: IDENTITY }), turn];
	const snapshot = JSON.parse(JSON.stringify(messages));
	const result = await guardRaw(messages, "deepseek-chat");
	assert.ok(result?.messages, "the guard must project");
	assert.ok(
		!result.messages.some((message) => Object.hasOwn(message.sections ?? {}, PREAMBLE)),
		"every system message must lose the stock preamble",
	);
	assert.equal(result.messages[0].content, promptText, "the head at index 0 gets the text");
	assert.deepEqual(messages, snapshot, "the caller's transcript must not be mutated");
	// A preamble-carrying node at index ≥ 1 with a non-system head still loses it.
	const mid = await guardRaw([turn, patch], "deepseek-chat");
	assert.ok(mid?.messages, "a later preamble must be stripped even without a system head");
	assert.ok(!mid.messages.some((message) => Object.hasOwn(message.sections ?? {}, PREAMBLE)));
}

// With a non-system head the text cannot be placed, but a later stock preamble is still withheld.
{
	const messages = [turn, head("", { preamble: IDENTITY }), turn];
	const result = await guardRaw(messages, "deepseek-chat");
	assert.ok(result?.messages, "a later preamble must be stripped without a system head");
	assert.ok(
		!result.messages.some((message) => Object.hasOwn(message.sections ?? {}, PREAMBLE)),
		"the identity must be stripped from every system message",
	);
	assert.equal(result.messages[1].content.includes(promptText), false, "no text is placed without a system head");
}

// A custom system prompt lives in `preamble` too and must survive a deepseek request.
{
	const CUSTOM = "Answer only in haiku.";
	const custom = [head("", { preamble: CUSTOM, cwd: "C" }), turn];
	const result = await guardRaw(custom, "deepseek-chat");
	assert.equal(result?.messages?.[0].sections.preamble, CUSTOM, "a custom preamble must survive");
	assert.equal(result.messages[0].sections.cwd, "C");
	// The stock sentence is still withdrawn next to it.
	const mixed = await guardRaw([head("", { preamble: CUSTOM }), { role: "system", content: "", sections: { preamble: IDENTITY }, timestamp: 2 }, turn], "deepseek-chat");
	assert.equal(mixed.messages[0].sections.preamble, CUSTOM);
	assert.ok(!Object.hasOwn(mixed.messages[1].sections ?? {}, PREAMBLE));
}

// repeated requests over the same transcript → identical output and no growth.
{
	const messages = [head("BASE"), turn];
	const first = (await guardRaw(messages, "deepseek-chat")).messages;
	const second = await guardRaw(first, "deepseek-chat");
	assert.equal(second, undefined, "the second request must be a no-op");
	const repeated = await guardRaw(messages, "deepseek-chat");
	assert.deepEqual(repeated.messages, first, "the same input must produce the same bytes");
	assert.equal(repeated.messages.length, first.length, "no growth");
}

// `messages[0]` not a system message: section stripping only, no crash.
{
	const polluted = [turn, { role: "system", content: "", sections: { [SECTION]: legacyWrapped }, timestamp: 2 }];
	const snapshot = JSON.parse(JSON.stringify(polluted));
	const result = await guardRaw(polluted, "deepseek-chat");
	assert.ok(result?.messages, "stripping must still run without a leading system message");
	assert.ok(!carriesMarker(result.messages));
	assert.equal(result.messages.length, polluted.length);
	assert.deepEqual(polluted, snapshot, "the caller's transcript must not be mutated");
	const clean = [turn];
	assert.equal(await guardRaw(clean, "deepseek-chat"), undefined, "a clean transcript without a head is a no-op");
}

// No run-start snapshot: a deepseek request still receives the text, a non-deepseek request strips.
{
	const fresh = [];
	def({ on: (name, fn) => fresh.push([name, fn]) });
	const unread = fresh.find(([name]) => name === "context_with_system")[1];
	const deepseek = await unread(
		{ type: "context_with_system", messages: [head(""), turn] },
		{ model: { id: "deepseek-chat" } },
	);
	assert.ok(deepseek?.messages?.[0].content.startsWith(promptText), "the guard must fall back to prompt.md");
	const other = await unread(
		{
			type: "context_with_system",
			messages: [head("BASE"), { role: "system", content: "", sections: { [SECTION]: legacyWrapped }, timestamp: 2 }, turn],
		},
		{ model: { id: "gpt-5" } },
	);
	assert.ok(other?.messages, "a legacy record must be stripped without a snapshot");
	assert.ok(!carriesMarker(other.messages));
}

console.log("ok context_with_system guard");

// ---------------------------------------------------------------------------
// Mechanism check against the installed Pi
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);

function resolvePiPackage() {
	if (process.env.PI_PKG !== undefined) {
		assert.ok(process.env.PI_PKG.trim(), "PI_PKG is set but empty");
		return resolve(process.env.PI_PKG);
	}
	// Resolve the main entry and walk up to its package directory. The exports map hides
	// package.json, and it declares only the `import` condition, so try the ESM resolver first.
	for (const attempt of [
		() => fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
		() => require.resolve("@earendil-works/pi-coding-agent"),
	]) {
		let dir;
		try {
			dir = dirname(attempt());
		} catch {
			continue;
		}
		while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
		if (existsSync(join(dir, "package.json"))) return dir;
	}
	const releases = join(homedir(), ".pi", "agent", "install", "releases");
	const found = existsSync(releases)
		? readdirSync(releases, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(releases, entry.name, "node_modules", "@earendil-works", "pi-coding-agent"))
				.filter((dir) => existsSync(join(dir, "dist", "core", "system-prompt.js")))
				.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
				.reverse()
		: [];
	if (found.length === 0) {
		assert.fail(
			`pi package not found: set PI_PKG to the @earendil-works/pi-coding-agent directory (checked ${releases})`,
		);
	}
	return found[0];
}

const pkg = resolvePiPackage();
assert.ok(
	existsSync(join(pkg, "dist", "core", "system-prompt.js")),
	`no pi package at ${pkg}: set PI_PKG to the @earendil-works/pi-coding-agent directory`,
);
const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;

// Drift guard: the exact stock preamble is what gets withheld, so a pi release that reworded it
// would silently stop withholding anything. Fail loudly instead, across every installed version.
{
	const releases = join(homedir(), ".pi", "agent", "install", "releases");
	const files = existsSync(releases)
		? readdirSync(releases, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) =>
					join(releases, entry.name, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "system-prompt.js"),
				)
				.filter((file) => existsSync(file))
		: [];
	const source = readFileSync(join(pkg, "dist", "core", "system-prompt.js"), "utf8");
	assert.ok(source.includes(JSON.stringify(STOCK_PREAMBLE)), `pi ${version} no longer builds the expected stock preamble`);
	for (const file of files) {
		assert.ok(
			readFileSync(file, "utf8").includes(JSON.stringify(STOCK_PREAMBLE)),
			`${file} builds a different stock preamble: update STOCK_PREAMBLE in index.ts and check.mjs`,
		);
	}
	assert.equal(STOCK_PREAMBLE.length, 169, "the stock preamble is 169 characters");
}

const load = (path) => import(pathToFileURL(path).href);

const { buildSystemPromptSections, diffSystemPromptSections, normalizeBuildSystemPromptOptions } = await load(
	join(pkg, "dist", "core", "system-prompt.js"),
);
const { getCurrentSystemMessage, collapseSystemMessages } = await load(
	join(pkg, "..", "pi-ai", "dist", "utils", "transcript.js"),
);
const { getSystemMessageText, renderSystemMessageUpdate } = await load(
	join(pkg, "..", "pi-ai", "dist", "utils", "text.js"),
);

// Pi's own base prompt, built from the same options a session would pass.
const baseSections = buildSystemPromptSections(
	normalizeBuildSystemPromptOptions({
		cwd: join(tmpdir(), "pi-deepseek-check"),
		selectedTools: ["read", "bash", "edit", "write"],
		contextFiles: [{ path: "AGENTS.md", content: "PROJECT RULES" }],
		sections: {},
	}),
);
assert.equal(baseSections.preamble.startsWith("You are an expert coding assistant"), true);
assert.ok(!Object.hasOwn(baseSections, SECTION), "the base prompt has no deepseek section");
assert.equal(diffSystemPromptSections(baseSections, baseSections), undefined, "unchanged runs must write no delta");
assert.ok(diffSystemPromptSections({}, baseSections).preamble, "a fresh transcript gets the base prompt");
assert.ok(Object.hasOwn(baseSections, "project_context"));
assert.ok(Object.hasOwn(baseSections, "cwd"));
assert.throws(
	() => buildSystemPromptSections(normalizeBuildSystemPromptOptions({ sections: { preamble: "x" } })),
	/reserved|preamble/i,
	"pi rejects a preamble section, which is why the text cannot be a section",
);

// The guard's projection is what the provider receives: pi's own collapse + render.
const headMessage = head("", baseSections);
const projected = await guardRaw([headMessage, turn], "deepseek-chat");
assert.ok(projected?.messages, "the guard must project a base-prompt head");
const renderProjection = (messages) =>
	getSystemMessageText(collapseSystemMessages({ messages }).messages[0]);

const rendered = renderProjection(projected.messages);
assert.ok(rendered.startsWith(promptText), "(a) the rendered prompt must start with the text");
assert.ok(!rendered.includes(SECTION), "(b) the rendered prompt must not name the section");
const openings = ["tools", "rules", "docs", "project_context", "skills", "cwd"]
	.map((name) => ({ name, at: rendered.indexOf(`<${name}>`) }))
	.filter(({ at }) => at !== -1);
assert.ok(openings.length >= 5, `expected the base sections, saw ${openings.map((o) => o.name).join(",")}`);
for (let i = 1; i < openings.length; i++) {
	assert.ok(
		openings[i - 1].at < openings[i].at,
		`(c) section order must be tools, rules, docs, project_context, skills, cwd: ${openings.map((o) => o.name)}`,
	);
}
assert.deepEqual(
	openings.map((o) => o.name),
	["tools", "rules", "docs", "project_context", "cwd"],
	"(c) the sections pi built must open in order",
);
assert.ok(!Object.hasOwn(projected.messages[0].sections, PREAMBLE), "(d) the head copy drops the preamble");
assert.equal(projected.messages[0].sections.cwd, baseSections.cwd, "(d) the other sections survive");
assert.equal(renderProjection(projected.messages), rendered, "(e) rendering twice must be byte-identical");
assert.equal(getCurrentSystemMessage(projected.messages).content, promptText, "the head's content is the text");
assert.ok(!rendered.includes("</deepseek_policy>"));
assert.ok(baseSections.preamble.includes(IDENTITY), "pi's preamble holds the identity sentence");
assert.ok(!rendered.includes(IDENTITY), "(f) the identity sentence must not be rendered for deepseek");

// A non-deepseek request renders the stock prompt, identity sentence included, untouched.
const stock = renderProjection([headMessage, turn]);
assert.ok(stock.includes(IDENTITY), "(g) a non-deepseek request renders the identity sentence");
assert.ok(!stock.includes(promptText), "(g) a non-deepseek request carries no prompt text");
assert.ok(!stock.includes(SECTION));
assert.ok(
	stock.indexOf(IDENTITY) < stock.indexOf("<tools>"),
	"(g) the identity sentence must lead the stock prompt's sections",
);
// And a model switch restores it on the next request, since the guard returned undefined.
assert.equal(await guardRaw(projected.messages, "gpt-5"), undefined, "(g) switching away must be a no-op");
assert.ok(renderProjection([headMessage, turn]).includes(IDENTITY));

console.log(`ok pi render order (pi ${version})`);

// ---------------------------------------------------------------------------
// What the two provider families actually put on the wire
// ---------------------------------------------------------------------------
// `getSystemMessageText` ignores section names, so a section-bearing node at index >= 1 has to
// go through `renderSystemMessageUpdate`, which is what the providers call for it
// (openai-completions.js:928, anthropic-messages.js:1062, openai-responses-shared.js:181).
const wire = (messages) =>
	collapseSystemMessages({ messages })
		.messages.filter((message) => message.role === "system")
		.map((message, index) => (index === 0 ? getSystemMessageText(message) : renderSystemMessageUpdate(message)))
		.join("\n\n");
const midConvoWire = (messages) =>
	messages
		.filter((message) => message.role === "system")
		.map((message, index) => (index === 0 ? getSystemMessageText(message) : renderSystemMessageUpdate(message)))
		.join("\n\n");

// A `{ deepseek_policy: null }` record would be announced by name on a mid-conversation model.
{
	const record = { role: "system", content: "", sections: { [SECTION]: null }, timestamp: 2 };
	assert.ok(
		renderSystemMessageUpdate(record).includes(`Removed system prompt section "${SECTION}"`),
		"pi announces a null section by name, which is why it cannot reach the wire",
	);
	for (const id of ["deepseek-chat", "gpt-5"]) {
		const result = await guardRaw([head("", baseSections), record, turn], id);
		const messages = result?.messages ?? [head("", baseSections), record, turn];
		assert.ok(!carriesMarker(messages), `${id}: no system message may keep the marker key`);
		assert.ok(!midConvoWire(messages).includes(SECTION), `${id}: the marker must not reach the wire`);
		assert.ok(!midConvoWire(messages).includes("Removed system prompt section"), `${id}: no removal notice`);
	}
	// A non-null record would be announced with its text.
	const setRecord = { role: "system", content: "", sections: { [SECTION]: legacyWrapped }, timestamp: 2 };
	assert.ok(renderSystemMessageUpdate(setRecord).includes(SECTION));
	const stripped = await guardRaw([head("", baseSections), setRecord, turn], "deepseek-chat");
	assert.ok(!midConvoWire(stripped.messages).includes(SECTION), "a non-null record must not reach the wire either");
}

// pi unshifts its prompt patch at index 0, so the stock preamble can sit on a later node.
const promptPatch = { role: "system", content: "", sections: { ...baseSections }, timestamp: 2 };
for (const [family, render] of [
	["collapse", wire],
	["midconvo", midConvoWire],
]) {
	const messages = [head("", baseSections), promptPatch, turn];
	const snapshot = JSON.parse(JSON.stringify(messages));
	const result = await guardRaw(messages, "deepseek-chat");
	assert.ok(result?.messages, `${family}: the guard must project`);
	const text = render(result.messages);
	assert.ok(text.startsWith(promptText), `${family}: the text must lead the rendered prompt`);
	assert.ok(!text.includes(IDENTITY), `${family}: the identity sentence must not reach the wire`);
	assert.ok(!text.includes(`section "${PREAMBLE}"`), `${family}: no preamble update notice`);
	assert.ok(text.includes("<tools>"), `${family}: the rest of the prompt still arrives`);
	assert.deepEqual(messages, snapshot, `${family}: the caller's transcript must not be mutated`);
	// Restoring: the transcript still holds it, so a non-deepseek request renders it again.
	assert.equal(await guardRaw(messages, "gpt-5"), undefined, `${family}: switching away is a no-op`);
	assert.ok(render(messages).includes(IDENTITY), `${family}: the identity sentence returns`);
	assert.ok(!render(messages).includes(promptText), `${family}: the text is gone`);
}

// A later node carrying only the identity preamble loses it while a custom preamble survives.
{
	const CUSTOM = "Answer only in haiku.";
	const messages = [head("", { preamble: CUSTOM }), { role: "system", content: "", sections: { preamble: IDENTITY }, timestamp: 2 }, turn];
	const result = await guardRaw(messages, "deepseek-chat");
	const text = midConvoWire(result.messages);
	assert.ok(text.includes(promptText), "the text must arrive");
	assert.ok(text.includes(CUSTOM), "a custom system prompt must survive on a deepseek request");
	assert.ok(!text.includes(IDENTITY), "the stock identity sentence must not");
}

// The identity sentence inside a real pi base prompt is stripped even where the text cannot go.
{
	const later = { role: "system", content: "", sections: { preamble: baseSections.preamble }, timestamp: 2 };
	const result = await guardRaw([turn, later], "deepseek-chat");
	assert.ok(result?.messages, "a later stock preamble must be withheld");
	assert.ok(!midConvoWire(result.messages).includes(IDENTITY), "the identity must not be announced");
}

// The pi shape: its own prompt patch leads at index 0 without a preamble, and the node carrying
// the stock preamble sits at index 1. The text lands on index 0, the sentence leaves index 1.
{
	const patch = { role: "system", content: "", sections: { cwd: baseSections.cwd }, timestamp: 0 };
	const carrier = { role: "system", content: "", sections: { ...baseSections }, timestamp: 2 };
	const messages = [patch, carrier, turn];
	const snapshot = JSON.parse(JSON.stringify(messages));
	const result = await guardRaw(messages, "deepseek-chat");
	assert.ok(result?.messages, "the guard must project");
	assert.equal(result.messages[0].content, promptText, "the text lands on the leading system message");
	assert.ok(!Object.hasOwn(result.messages[1].sections, PREAMBLE), "the later carrier loses the preamble");
	assert.equal(result.messages[1].sections.cwd, baseSections.cwd, "its other sections stay");
	assert.equal(result.messages[0].sections.cwd, baseSections.cwd, "the patch keeps its own sections");
	assert.deepEqual(messages, snapshot, "the caller's transcript must not be mutated");
	for (const render of [wire, midConvoWire]) {
		assert.ok(!render(result.messages).includes(IDENTITY), "the identity must not reach the wire");
	}
	assert.equal(await guardRaw(result.messages, "deepseek-chat"), undefined, "a second pass is a no-op");
}

console.log(`ok provider wire (pi ${version})`);
