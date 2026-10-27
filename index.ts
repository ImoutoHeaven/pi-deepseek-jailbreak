/**
 * Injects the DeepSeek jailbreak prompt into the system prompt of DeepSeek sessions only.
 *
 * The text is not a prompt section: pi renders a section wrapped as `<name>\n...\n</name>`
 * and names the block, which identifies it as an injected block. Instead the
 * `context_with_system` guard places the raw text at the head of the leading system
 * message's `content`, ahead of every section, on every request. The transcript records
 * nothing for it, so nothing is persisted and nothing leaks to another model, and an
 * unchanged run sends byte-identical prompts turn after turn.
 *
 * The text contradicts the stock identity sentence that opens pi's default preamble, so the
 * guard withholds it while the text is in force and lets it back the moment the text is not.
 * It withholds it on every system message, not only the leading one, and only when the value
 * is that stock sentence: a custom system prompt also lands in `preamble` and must survive.
 * Request-only, like the text itself.
 *
 * The guard reads the live model each request. Pi reuses the run-start options for the rest
 * of the run (agent-session.js:543) while sending the live model per turn (:562), so a model
 * switch mid-run is corrected on the very next request.
 *
 * Precedence caveat: pi's `_installAgentForcedPromptProjection` runs after `context_with_system`,
 * so when any extension sets `forceSystemPrompt` the forced text wins and the guard has no effect.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isDeepSeekModel } from "./model.js";

// Legacy only: earlier versions recorded the text as a section under this name. The
// load-time check stays so a transcript written by those versions can still be scrubbed.
const SECTION = "deepseek_policy";
// The raw, untagged section holding pi's stock identity sentence.
const PREAMBLE = "preamble";
// Pi's stock preamble, byte for byte (dist/core/system-prompt.js:83, identical in 1.3.0 and
// 1.4.0). Only this exact value is withheld: a copied-and-edited default prompt is the user's
// own text and stays, and an unrelated custom system prompt lives in the same section.
const STOCK_PREAMBLE =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
const PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), "prompt.md");

// Pi reports an invalid section name as a generic run error with no extension attribution.
if (!/^[a-z][a-z0-9_-]*$/.test(SECTION) || SECTION === "preamble") {
	throw new Error(`pi-deepseek-jailbreak: invalid section name ${SECTION}`);
}

/**
 * The head's text when the prompt can go there, or undefined when the content holds anything pi
 * never puts in a system message: rewriting that would silently drop the other blocks.
 */
function headText(content: any) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	// A single text block is what pi sends most often; read it without mapping or joining, so an
	// already aligned request still allocates nothing.
	if (content.length === 1 && content[0]?.type === "text") return content[0].text;
	if (!content.every((block) => block?.type === "text")) return undefined;
	return content.map((block) => block.text).join("\n");
}

let reported = false;

function report(ctx, message, type = "error") {
	if (reported) return;
	try {
		const ui = ctx?.ui;
		if (!ui) return; // Headless: the flag stays clear so a later UI session still gets told.
		reported = true;
		ui.notify(`pi-deepseek-jailbreak: ${message}`, type);
	} catch {
		// A missing or inactive UI must not break the session.
	}
}

/** Read prompt.md per run so edits take effect without a reload. */
function readPrompt(ctx) {
	let text;
	try {
		text = readFileSync(PROMPT_FILE, "utf8").trim();
	} catch {
		report(ctx, "prompt.md unreadable");
		return;
	}
	if (!text) {
		report(ctx, "prompt.md is empty");
		return;
	}
	return text;
}

/**
 * Copy `messages` with every legacy marker record removed, and while the text is in force
 * with the stock identity preamble removed from every system message. Returns undefined when
 * nothing needed to change.
 *
 * Both keys have to go from every system message, not only the leading one: pi unshifts its
 * own prompt patch at index 0 (agent-session.js:1525-1528), so the node carrying `preamble`
 * sits later, and a later system message is rendered by name (text.js:29-32). A `null`
 * marker record renders as a `Removed system prompt section` sentence, so it goes too.
 */
function project(messages, stripIdentity) {
	let next;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		const sections = message?.sections;
		if (message?.role !== "system" || !sections) continue;
		let copy = message;
		if (Object.hasOwn(sections, SECTION)) copy = withoutSection(copy, SECTION);
		if (stripIdentity && isStockPreamble(sections[PREAMBLE])) copy = withoutSection(copy, PREAMBLE);
		if (copy === message) continue;
		next ??= messages.slice();
		next[i] = copy;
	}
	return next;
}

/** Whether a section value is pi's stock preamble, the only one the text replaces. */
function isStockPreamble(value) {
	return value === STOCK_PREAMBLE;
}

/** A copy of `message` without `name` in its sections, dropping `sections` when it empties. */
function withoutSection(message, name) {
	const kept = { ...message.sections };
	delete kept[name];
	if (Object.keys(kept).length === 0) {
		const rest = { ...message };
		delete rest.sections;
		return rest;
	}
	return { ...message, sections: kept };
}

export default function deepseekJailbreak(pi: ExtensionAPI) {
	// This run's prompt.md snapshot, refreshed at every run start so the guard never does I/O.
	let promptText;

	pi.on("before_agent_start", (event, ctx) => {
		promptText = readPrompt(ctx);
		const options = event.systemPromptOptions;
		const sections = options.sections;
		// The transcript records nothing for the text; the guard projects it onto each request.
		delete sections[SECTION];
		if (!isDeepSeekModel(ctx.model)) return;
		if (options.forceSystemPrompt !== undefined) {
			report(ctx, "prompt is forced by another extension; the text is not delivered", "warning");
		}
	});

	pi.on("context_with_system", (event, ctx) => {
		const messages = event.messages;
		if (!Array.isArray(messages) || messages.length === 0) return;
		const isDeepSeek = isDeepSeekModel(ctx.model);
		// A missing run-start snapshot falls back to the file, so the text still arrives.
		const text = isDeepSeek ? (promptText ?? readPrompt(ctx)) : undefined;
		let next = project(messages, text !== undefined);
		const head = messages[0];
		if (text !== undefined && head?.role === "system") {
			const projected = next === undefined ? head : next[0];
			const existing = headText(projected.content);
			// Aligned: the text is already in the head, at the front or after a compacted summary.
			if (existing !== undefined) {
				const content = existing.includes(text) ? existing : existing ? `${text}\n\n${existing}` : text;
				if (content !== existing) {
					// Never mutate the caller's array, message objects or sections objects.
					next ??= messages.slice();
					next[0] = { ...projected, content };
				}
			}
		}
		// Aligned: return undefined so the request stays byte-identical and allocation-free.
		return next === undefined ? undefined : { messages: next };
	});
}
