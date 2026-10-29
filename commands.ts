/**
 * `on`, `off` and `toggle` set this session, and `reset` drops that answer. `remember` writes it
 * into the config file, so the next process resolves the same way without the environment channel.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Hooks = {
	set(ctx: any, mode: "on" | "off" | "toggle"): { mode: "on" | "off"; applied: boolean };
	reset(ctx: any): "on" | "off";
	remember(ctx: any, mode: "on" | "off"): { ok: boolean; message: string };
	panel(ctx: any): string;
};

const ARGS = ["on", "off", "toggle", "reset", "remember on", "remember off"];

function say(ctx: any, text: string, type: "info" | "error" = "info") {
	try {
		ctx?.ui?.notify?.(text, type);
	} catch {
		// A mode without a UI still runs the command.
	}
}

export function registerCommands(pi: ExtensionAPI, hooks: Hooks) {
	pi.registerCommand("jailbreak", {
		description: "Show or set the mode: on, off, toggle, reset, remember",
		getArgumentCompletions: (prefix: string) => {
			const typed = String(prefix ?? "").trim();
			const items = ARGS.filter((value) => value.startsWith(typed));
			return items.length ? items.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args: string, ctx: any) => {
			const [first, second] = String(args ?? "")
				.trim()
				.toLowerCase()
				.split(/\s+/)
				.filter(Boolean);
			if (!first) {
				say(ctx, hooks.panel(ctx));
				return;
			}
			if (first === "on" || first === "off" || first === "toggle") {
				const result = hooks.set(ctx, first);
				say(ctx, result.applied ? `jailbreak ${result.mode}` : `jailbreak ${result.mode} (unchanged)`);
				return;
			}
			if (first === "reset") {
				say(ctx, `jailbreak ${hooks.reset(ctx)} (config)`);
				return;
			}
			if (first === "remember") {
				if (second !== "on" && second !== "off") {
					say(ctx, "remember on | remember off");
					return;
				}
				const result = hooks.remember(ctx, second);
				say(ctx, result.ok ? `remembered: jailbreak ${second} in ${result.message}` : result.message, result.ok ? "info" : "error");
				return;
			}
			say(ctx, "on | off | toggle | reset | remember on | remember off");
		},
	});
}
