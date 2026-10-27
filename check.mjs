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
assert.equal(lines[0], "[OPERATION: STABLE]", "prompt.md must open with its operation marker");
assert.ok(
	lines.at(-1).endsWith("出现在潜意识或思维链中时。"),
	"prompt.md must end with the closing trigger paragraph",
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
const wrapped = `<deepseek_policy>\n${promptText}\n</deepseek_policy>`;

const run = async (id, seed = {}) => {
	const ev = { systemPromptOptions: { sections: { ...seed } } };
	for (const [, fn] of handlers) await fn(ev, { model: { id } });
	return ev.systemPromptOptions.sections;
};

// (a) a DeepSeek id injects exactly prompt.md
const deepseekSections = await run("deepseek-chat");
assert.equal(deepseekSections.deepseek_policy, promptText, "deepseek run must inject prompt.md verbatim");
assert.equal(deepseekSections.deepseek_policy.trim(), promptText, "injected text must be trimmed");

// (b) another model removes a seeded section
const otherSections = await run("gpt-5", { deepseek_policy: "stale" });
assert.ok(!("deepseek_policy" in otherSections), "non-deepseek run must remove a seeded section");

// (c) another model leaves other sections alone
assert.deepEqual(await run("gpt-5", { mcp_servers: "X" }), { mcp_servers: "X" });

// (d) a DeepSeek run keeps other sections
assert.equal((await run("deepseek-chat", { mcp_servers: "X" })).mcp_servers, "X");

console.log("ok extension injects prompt.md");

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
// The per-request guard for a mid-run model switch
// ---------------------------------------------------------------------------
const guard = handlers.find(([name]) => name === "context_with_system")[1];
const head = (sections) => ({ role: "system", content: "BASE", ...(sections ? { sections } : {}), timestamp: 0 });
const turn = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
const call = async (messages, id) => {
	const res = await guard({ type: "context_with_system", messages }, { model: { id } });
	return res === undefined ? messages : res.messages;
};
// The fold pi's getCurrentSystemMessage performs.
const fold = (messages) => {
	let value;
	for (const message of messages) {
		if (message.role !== "system" || !message.sections) continue;
		if (!Object.hasOwn(message.sections, "deepseek_policy")) continue;
		value = message.sections.deepseek_policy === null ? undefined : message.sections.deepseek_policy;
	}
	return value;
};

// Aligned: same array reference, nothing allocated.
const deepseekHead = head({ deepseek_policy: wrapped });
const aligned = [deepseekHead, turn];
assert.equal(await call(aligned, "deepseek-chat"), aligned, "aligned deepseek request must return the same array");
assert.equal(fold(aligned), wrapped);
const otherHead = head();
const off = [otherHead, turn];
assert.equal(await call(off, "gpt-5"), off, "aligned non-deepseek request must return the same array");

// Switch away mid-run: the delta removes the section and leaves index 0 untouched.
const away = await call(aligned, "gpt-5");
assert.equal(away[0], deepseekHead, "leading system message must stay at index 0, identity intact");
assert.equal(fold(away), undefined, "switching away must fold the section away");
assert.equal(away.length, 3, "one delta message only");
const removal = away[1];
assert.deepEqual(removal, { role: "system", content: "", sections: { deepseek_policy: null }, timestamp: removal.timestamp });
assert.equal(typeof removal.timestamp, "number");

// Switch to deepseek mid-run: the delta adds the full text.
const to = await call(off, "deepseek-chat");
assert.equal(to[0], otherHead, "leading system message must stay at index 0, identity intact");
assert.equal(fold(to), wrapped, "switching to deepseek must fold the full section in");
assert.equal(to.length, 3);

// Round trip back to deepseek, and placement after the last section-carrying system message.
const back = await call(away, "deepseek-chat");
assert.equal(back[0], deepseekHead);
assert.equal(fold(back), wrapped, "switching back must fold the full section in");
const mid = { role: "system", content: "", sections: { deepseek_policy: "x" }, timestamp: 2 };
const placed = await call([otherHead, mid, turn], "gpt-5");
assert.equal(placed.length, 4);
assert.equal(placed[2].sections.deepseek_policy, null, "delta must sit right after the last section-carrying system message");

// Pi's own steady state after switching away is `{ deepseek_policy: null }`. It must stay a no-op,
// or every turn would append another delta to the request.
const nullDelta = { role: "system", content: "", sections: { deepseek_policy: null }, timestamp: 2 };
const steady = [deepseekHead, nullDelta, turn];
assert.equal(await call(steady, "gpt-5"), steady, "a recorded null removal must be a no-op");
const reAdded = [otherHead, nullDelta, { role: "system", content: "", sections: { deepseek_policy: wrapped }, timestamp: 3 }, turn];
assert.equal(
	await call(reAdded, "deepseek-chat"),
	reAdded,
	"null-then-set folds to the current text, so the add direction must be a no-op too",
);
// Repeated requests over the same transcript must not grow it.
let growing = steady;
for (let i = 0; i < 5; i++) growing = await call(growing, "gpt-5");
assert.equal(growing, steady, "repeated requests must not append deltas");

// The guard never edits the caller's array: pi hands in the transcript it also reads afterwards.
{
	const original = [deepseekHead, turn];
	const before = original.length;
	const changed = await guard({ type: "context_with_system", messages: original }, { model: { id: "gpt-5" } });
	assert.equal(original.length, before, "the caller's array must not be mutated");
	assert.notEqual(changed?.messages, original, "a mismatch must return a new array");
}

// A guard whose run-start read never ran still removes what the transcript carries.
{
	const fresh = [];
	def({ on: (name, fn) => fresh.push([name, fn]) });
	const unread = fresh.find(([name]) => name === "context_with_system")[1];
	const res = await unread({ type: "context_with_system", messages: [deepseekHead, turn] }, { model: { id: "gpt-5" } });
	assert.ok(res?.messages, "removal must not depend on a prompt.md snapshot");
	assert.equal(fold(res.messages), undefined, "a transcript carrying the section must fold it away");
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

const load = (path) => import(pathToFileURL(path).href);

const { buildSystemPromptSections, diffSystemPromptSections, normalizeBuildSystemPromptOptions } = await load(
	join(pkg, "dist", "core", "system-prompt.js"),
);
const { getCurrentSystemPrompt } = await load(join(pkg, "..", "pi-ai", "dist", "utils", "transcript.js"));

// Pi's own wrapping of a custom section must match the guard's rendering.
const sections = (on) =>
	buildSystemPromptSections(
		normalizeBuildSystemPromptOptions({
			cwd: join(tmpdir(), "pi-deepseek-check"),
			selectedTools: ["read", "bash", "edit", "write"],
			sections: on ? { deepseek_policy: promptText } : {},
		}),
	);
const on = sections(true);
const renderedOff = sections(false);
assert.equal(on.deepseek_policy, wrapped, "pi renders the section exactly as the guard does");
assert.equal(diffSystemPromptSections(on, on), undefined, "unchanged runs must write no delta");
assert.deepEqual(diffSystemPromptSections(on, renderedOff), { deepseek_policy: null });
assert.ok(diffSystemPromptSections({}, on).deepseek_policy, "a compaction reset gets the section back");
assert.equal(
	(on.deepseek_policy.match(/<\/deepseek_policy>/g) ?? []).length,
	1,
	"the built section carries exactly one closing tag",
);

const headMessage = { role: "system", content: "", sections: on, timestamp: 1 };
assert.ok(getCurrentSystemPrompt([headMessage, turn]).includes(promptText));
assert.ok(getCurrentSystemPrompt([headMessage, turn, away[1]]).indexOf("deepseek_policy") === -1);

console.log(`ok pi diff (pi ${version})`);
