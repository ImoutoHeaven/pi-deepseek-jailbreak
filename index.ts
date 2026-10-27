/**
 * Injects the DeepSeek jailbreak prompt into the system prompt of DeepSeek sessions only.
 *
 * The section is decided at run start from the run's model and lands in the transcript as one
 * add/remove delta, so an unchanged run writes nothing. Pi then reuses that run-start snapshot
 * for the rest of the run (agent-session.js:543) while each turn sends the live model (:562),
 * so a model switch mid-run would keep shipping the old state to every later request. The
 * `context_with_system` guard repairs the request against the live model without writing a
 * transcript delta.
 *
 * Precedence caveat: pi's `_installAgentForcedPromptProjection` runs after `context_with_system`,
 * so when any extension sets `forceSystemPrompt` the forced text wins and the guard has no effect.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isDeepSeekModel } from "./model.js";

const SECTION = "deepseek_policy";
const PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), "prompt.md");

// Pi reports an invalid section name as a generic run error with no extension attribution.
if (!/^[a-z][a-z0-9_-]*$/.test(SECTION) || SECTION === "preamble") {
	throw new Error(`pi-deepseek-jailbreak: invalid section name ${SECTION}`);
}

/** Render a section the way pi's buildSystemPromptSections wraps custom sections. */
const render = (text) => `<${SECTION}>\n${text}\n</${SECTION}>`;

/** Section value the transcript currently folds to, mirroring pi's getCurrentSystemMessage. */
function foldedSection(messages) {
	let value;
	for (const message of messages) {
		if (message?.role !== "system" || !message.sections) continue;
		if (!Object.hasOwn(message.sections, SECTION)) continue;
		value = message.sections[SECTION] === null ? undefined : message.sections[SECTION];
	}
	return value;
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

export default function deepseekJailbreak(pi: ExtensionAPI) {
	// This run's prompt.md snapshot, refreshed at every run start so the guard never does I/O.
	let promptText;

	pi.on("before_agent_start", (event, ctx) => {
		promptText = readPrompt(ctx);
		const options = event.systemPromptOptions;
		const sections = options.sections;
		if (!isDeepSeekModel(ctx.model)) {
			delete sections[SECTION];
			return;
		}
		if (options.forceSystemPrompt !== undefined) {
			// A forced prompt carries no sections at all, so the provider never sees this one.
			report(ctx, "prompt is forced by another extension; the section is not delivered", "warning");
		}
		if (promptText === undefined) {
			delete sections[SECTION];
			return;
		}
		// Raw text: pi wraps every custom section as <name>\n...\n</name>.
		sections[SECTION] = promptText;
	});

	pi.on("context_with_system", (event, ctx) => {
		const messages = event.messages;
		if (!Array.isArray(messages) || messages.length === 0) return;
		const isDeepSeek = isDeepSeekModel(ctx.model);
		// A missing prompt.md snapshot only prevents adding text; removal never needs it.
		if (isDeepSeek && promptText === undefined) return;
		const desired = isDeepSeek ? render(promptText) : undefined;
		// Aligned: return undefined so the request stays byte-identical and allocation-free.
		if (foldedSection(messages) === desired) return;
		const delta = {
			role: "system",
			content: "",
			sections: { [SECTION]: desired ?? null },
			timestamp: Date.now(),
		};
		let at = messages.length;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role === "system" && message.sections && Object.hasOwn(message.sections, SECTION)) {
				at = i + 1;
				break;
			}
		}
		const next = messages.slice();
		// Never replace index 0: pi errors when a handler drops the leading system message.
		next.splice(Math.max(at, 1), 0, delta);
		return { messages: next };
	});
}
