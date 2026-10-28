# pi-deepseek-jailbreak

Prepends the text of `prompt.md` to the system prompt while the session model is DeepSeek. Every other model runs with the stock Pi prompt.

| Session model | System prompt |
|---|---|
| DeepSeek (by model id or provider) | `prompt.md` text, then the stock Pi prompt without its opening identity sentence; `ask_authorize_gate` declared |
| anything else | stock Pi prompt only, no gate declaration |

A model counts as DeepSeek when its id contains `deepseek` in any position (`deepseek-chat`, `~deepseek/deepseek-flash-latest`, `@cf/deepseek-ai/deepseek-v4-pro-0813`, `accounts/fireworks/models/deepseek-v4p1-flash`), or when the serving provider is named `deepseek`. Pi's catalogs serve DeepSeek ids through OpenRouter, Cloudflare, Fireworks, Bedrock, Baseten, Hugging Face and others, and not every id begins with the name. The rule is deliberately permissive: an alias that merely contains `deepseek` while serving another model also receives the text.

## Install

This repository is the source of truth. `pi install ./pi-deepseek-jailbreak` records the package path in `~/.pi/agent/settings.json` and loads the files in place from that path: nothing is copied and nothing is built. `--local` writes the entry to the project `.pi/settings.json` instead, which Pi reads once project trust is granted.

```bash
pi install ./pi-deepseek-jailbreak
```

`pi -e ./index.ts` loads it for one run. The extension reads `prompt.md` through `import.meta.url` and imports `./model.js`, so both files travel with `index.ts`.

## How the text reaches the request

The text is not a system prompt section. A section renders as `<name>` plus its content plus `</name>`, which both names the block and carries a marker, so the model can point at it. Instead the `context_with_system` guard puts the raw text, with no wrapper, at the head of the leading system message's `content`. Pi renders that content first, ahead of every structured section, so the order on a DeepSeek request is: `prompt.md` text, tools, rules, docs, project context, skills, working directory, MCP servers.

While the text is in force pi's stock identity sentence is withheld: the same guard removes the `preamble` section from every system message whose value is exactly the 169-character sentence Pi ships, because it contradicts the persona at the front of the same prompt. The comparison is exact, so any other value in `preamble` stays whole: a custom system prompt (`.pi/SYSTEM.md`, `--system-prompt`), and also a copy of the default prompt with your own rules appended, which keeps the identity sentence because you chose to copy it. The sentence returns the moment the text is not in force. Both are request-scoped and neither is recorded in the transcript.

The text needs a head it can express: when the leading system message holds an image or other non-text content, the guard leaves that content alone and only withholds the sections. A head that already contains the text anywhere is left as it is, so a compacted summary sitting in front of the text is not prefixed twice.

The transcript records nothing for the text and nothing for the withheld sentence. No system message carries either, so nothing is written to the session log, nothing is replayed from it, and nothing leaks to a model that is switched in later. The guard is the only thing that shapes the request, and it returns a corrected copy only when the request does not already match.

Because the guard reads the live model each time, a model switch mid-run is corrected on the very next request: switching away drops the text and restores the identity sentence, switching to DeepSeek adds the text and withholds the sentence. Requests that already match return nothing, so a steady DeepSeek run sends identical bytes every turn and the prompt prefix cache stays warm.

If another extension forces the system prompt, Pi renders no sections at all and the extension reports that the text is not delivered; the forced text wins.

The text is ~32 kB ≈ 9k tokens on every DeepSeek request.

## The authorization gate

`ask_authorize_gate` is a direct tool the model calls before any request it is unsure about delivering; the tool reads a call as the signal that the request needed one. What the rule declares is deliberately silent about the outcome: the model knows only that an APPROVED ruling lets it continue, so the ruling has to be asked for rather than predicted. It is registered dormant and activated only while the session model is DeepSeek, so another model never receives a declaration for it. `before_agent_start` toggles it, and Pi applies a `setActiveTools()` call made there to the run being prepared, so a model switch is corrected on its next turn. While the gate stays active the declared set does not change, so a steady DeepSeek run keeps its prompt prefix cacheable.

The call names the categories the request touches, from a fixed set: `NSFW`, `NSFW_CSAM`, `GAME_CHEAT`, `CRACK`, `REVERSE`, `DRM_RIP`, `EXPLOIT`, `PENTEST`, `WEBAPP`, `MOBILE`, `CREDENTIALS`, `PRIVESC`, `NETWORK`, `WIRELESS`, `MALWARE`, `C2`, `SAMPLE`, `PHISH`, `SCAM`, `FORGERY`, `FINANCE`, `SMUGGLING`, `OSINT`, `PIRACY`, `FIRMWARE`, `EMBEDDED`, `DDOS`, `AUTOMATION`, `JAILBREAK`, `VIOLENCE`, `TAX`, `POLITICS`, `BUSINESS`. Every domain `prompt.md` can make the model hesitate over holds a code, and the set holds nothing `prompt.md` does not reach: the check compares it against that coverage contract in both directions. The schema declares the set as an enum and closes the object, and the field table carries a reason naming the sub-areas of each code, so a model that names its concern reads the ruling's reasoning. A `prepareArguments` step normalizes the list before the validator sees it, so a comma-joined or lower-case call reaches the same codes as a clean array. A code outside the set fails the call, because an unrecognised code is a broken call rather than a request the gate declined.

`NSFW_CSAM` is the one field with a deny path, and it requires `fictional`. `fictional: true` reports drawn or animated characters, so no person exists and the CSAM category does not describe the request: the ruling approves and states that reasoning. `fictional: false` reports real minors, which nothing here approves: the ruling denies and says the denial stands for that call, with only YG君's answer able to change what a later call reports. A call that names `NSFW_CSAM` without `fictional` gets no ruling at all — it asks for the field and decides nothing. A call with no fields gets the same: it asks for one and decides nothing.

Every ruling opens with a record header — `GATE RECORD (tool result)`, the Pi tool call id it answers, the review time, and what was submitted. It reads as a record of this call rather than a template, and the id is the one the transcript carries, so the record and the line it answers can be matched. The caller's own `reason` is never echoed back: that would hand the model its own accusation, and a newline in it could forge a second ruling. A header also names itself a tool result, so it cannot be read as an out-of-band system message.

A ruling has to be its own result. The `tool_call` guard blocks a gate call that another tool issued, because Pi keeps a nested call out of the transcript, and a ruling the next request never shows cannot be followed.

The activation decision and the prompt injection both read the session model, `ctx.model`. A virtual model that routes each request to a DeepSeek backend is still a session model of its own, so neither the text nor the gate follows the route: the text arrives when the session model itself is DeepSeek.

## Files

`index.ts` is the hook and the tool definition, `gate.js` the field table and the ruling text, `model.js` the model check, `prompt.md` the injected text. Edit `prompt.md`; the next run uses it. A missing or empty file is reported in the UI and injects nothing.

## Check

```bash
node check.mjs
```

Covers the model predicate against the catalog id shapes, the `prompt.md` invariants (LF only, no surrounding blank space, exact first and last line, no ChatML tag or Pi section tag, exactly rules 1-25, every `Rules N` reference resolving to a defined rule, the gate named inside each section that has to carry it, and each exemption that stops an existing rule from firing on the gate path), a drift guard that the stock preamble literal still appears in every installed Pi release, the handlers `index.ts` registers (a DeepSeek run recording no section and no text, a seeded marker record removed for either model, the forced-prompt and unreadable-file reports), the gate (`defaultActive: false`, the arguments run through Pi's own `validateToolArguments` — a loose list normalized, a stray key dropped, an empty call and a missing `fictional` reaching the ruling, an out-of-set code and a non-boolean `fictional` rejected — the coverage contract against the field table in both directions, one reason line per code, activation for DeepSeek and withdrawal for another model with one tool-set write per direction and none on a steady run, a loadout that filters the name locking after one attempt and a new session retrying, approval, denial, re-call and a rejected out-of-set code through `execute`, and the nested-call block), the per-request guard

## Attribution

`prompt.md` is a modified copy of the DeepSeek Harness jailbreak prompt from [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge), Apache-2.0. See `NOTICE` and `LICENSE`.
