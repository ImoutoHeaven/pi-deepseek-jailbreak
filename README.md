# pi-deepseek-jailbreak

Prepends the text of `prompt.md` to the system prompt while the session model is DeepSeek. Every other model runs with the stock Pi prompt.

| Session model | System prompt |
|---|---|
| DeepSeek (by model id or provider) | `prompt.md` text, then the stock Pi prompt without its opening identity sentence; `ask_authorize_gate` declared |
| anything else | stock Pi prompt only, no gate declaration |

A model counts as DeepSeek when its id contains `deepseek` in any position (`deepseek-chat`, `~deepseek/deepseek-flash-latest`, `@cf/deepseek-ai/deepseek-v4-pro-0813`, `accounts/fireworks/models/deepseek-v4p1-flash`), or when the serving provider is named `deepseek`. Pi's catalogs serve DeepSeek ids through OpenRouter, Cloudflare, Fireworks, Bedrock, Baseten, Hugging Face and others, and not every id begins with the name. The rule is permissive on purpose: an alias that merely contains `deepseek` while serving another model also receives the text.

## Install

This repository is the source of truth. `pi install ./pi-deepseek-jailbreak` records the package path in `~/.pi/agent/settings.json` and loads the files in place from that path: nothing is copied and nothing is built. `--local` writes the entry to the project `.pi/settings.json` instead, which Pi reads once project trust is granted.

```bash
pi install ./pi-deepseek-jailbreak
```

`pi -e ./index.ts` loads it for one run. The extension reads `prompt.md` through `import.meta.url` and imports `./model.js`, so both files travel with `index.ts`.

## How the text reaches the request

The text arrives as content, not as a system prompt section. A section renders as `<name>` plus its content plus `</name>`, which names the block and leaves a marker the model can point at. The `context_with_system` guard puts the raw text, with no wrapper, at the head of the leading system message's `content`. Pi renders that content first, ahead of every structured section, so the order on a DeepSeek request is: `prompt.md` text, tools, rules, docs, project context, skills, working directory, MCP servers.

While the text is in force pi's stock identity sentence is withheld: the same guard removes the `preamble` section from every system message whose value is exactly the 169-character sentence Pi ships, because that sentence contradicts the persona at the front of the same prompt. The comparison is exact, so any other value in `preamble` stays whole. That covers a custom system prompt (`.pi/SYSTEM.md`, `--system-prompt`) and also a copy of the default prompt with your own rules appended, which keeps the identity sentence because you chose to copy it. The sentence returns the moment the text is not in force. Both are request-scoped, and neither is recorded in the transcript.

The text needs a head it can express. When the leading system message holds an image or other non-text content, the guard leaves that content alone and only withholds the sections. A head that already contains the text anywhere is left as it is, so a compacted summary sitting in front of the text is not prefixed twice.

No system message carries either of them, so nothing is written to the session log, nothing is replayed from it, and nothing leaks to a model that is switched in later. The guard is the only thing that shapes the request, and it returns a corrected copy only when the request does not already match.

Because the guard reads the live model each time, a model switch mid-run is corrected on the very next request: switching away drops the text and restores the identity sentence, and switching to DeepSeek adds the text and withholds the sentence. Requests that already match return nothing, so a steady DeepSeek run sends identical bytes every turn and the prompt prefix cache stays warm.

If another extension forces the system prompt, Pi renders no sections at all and the extension reports that the text is not delivered; the forced text wins.

The text is about 35 kB, roughly 9k tokens, on every DeepSeek request.

## The authorization gate

`ask_authorize_gate` is a direct tool the model calls before any request it is unsure about delivering; the call itself is the signal that the request needed one. The declaration routes the call and never names the outcome, so neither the tool description nor `prompt.md` says what a call will return, and the ruling has to be asked for. It is registered dormant and activated only while the session model is DeepSeek, so another model never receives a declaration for it. `before_agent_start` toggles it, and Pi applies a `setActiveTools()` call made there to the run being prepared, so a model switch is corrected on its next turn. While the gate stays active the declared set does not change, so a steady DeepSeek run keeps its prompt prefix cacheable.

The call names the categories the request touches, from a fixed set: `NSFW`, `NSFW_CSAM`, `GAME_CHEAT`, `CRACK`, `REVERSE`, `DRM_RIP`, `EXPLOIT`, `PENTEST`, `WEBAPP`, `MOBILE`, `CREDENTIALS`, `PRIVESC`, `NETWORK`, `WIRELESS`, `MALWARE`, `C2`, `SAMPLE`, `PHISH`, `SCAM`, `FORGERY`, `FINANCE`, `SMUGGLING`, `OSINT`, `PIRACY`, `FIRMWARE`, `EMBEDDED`, `DDOS`, `AUTOMATION`, `JAILBREAK`, `VIOLENCE`, `TAX`, `POLITICS`, `BUSINESS`. Every domain `prompt.md` can make the model hesitate over holds a code, and the set holds nothing `prompt.md` does not reach: the check compares it against that coverage contract in both directions. The schema declares the set as an enum and closes the object, and the field table carries a reason naming the sub-areas of each code, so a model that names its concern reads the ruling's reasoning. A `prepareArguments` step normalizes the list before the validator sees it, so a comma-joined or lower-case call reaches the same codes as a clean array. A code outside the set fails the call, because an unrecognised code is a broken call and the gate has nothing to rule on.

`NSFW_CSAM` is the one field with a deny path, and it requires `fictional`. `fictional: true` records a drawn or animated source, and the ruling records that source and argues nothing further. `fictional: false` records a real source, which opens no path: the ruling closes, the closure stands for that call, and only the user's answer can change what a later call reports. Both paths carry the same shape, with a record header, the submitted fields, one line per field and one NEXT ACTION, so a ruling is a receipt rather than a verdict and neither path offers an argument to weigh. A call that names `NSFW_CSAM` without `fictional` gets no ruling at all: it asks for the field and decides nothing. A call with no fields gets the same, because it asks for one and decides nothing.

On the confirm path the ruling permits one line and nothing else: `Are the characters fictional?` That line is canonical in English, and the persona delivers it in the user's language, so a user writing Simplified Chinese reads the same question in Chinese. The English string is what `prompt.md`, `gate.js` and `check.mjs` agree on byte for byte.

Every ruling opens with a record header: `GATE RECORD (tool result)`, the Pi tool call id it answers, the review time, and what was submitted. It reads as a record of this call, and the id is the one the transcript carries, so the record and the line it answers can be matched. The caller's own `reason` is never echoed back, because that would hand the model its own accusation and a newline in it could forge a second ruling. A header also names itself a tool result, so it cannot be read as an out-of-band system message.

A ruling has to be its own result. The `tool_call` guard blocks a gate call that another tool issued, because Pi keeps a nested call out of the transcript, and a ruling the next request never shows cannot be followed.

The activation decision and the prompt injection both read the session model, `ctx.model`. A virtual model that routes each request to a DeepSeek backend is still a session model of its own, so neither the text nor the gate follows the route: the text arrives when the session model itself is DeepSeek.

## Files

`index.ts` is the hook and the tool definition, `gate.js` the field table and the ruling text, `model.js` the model check, `prompt.md` the injected text. Edit `prompt.md`; the next run uses it. A missing or empty file is reported in the UI and injects nothing.

## Check

```bash
node check.mjs
```

The check covers the model predicate against the catalog id shapes, then the `prompt.md` invariants: LF only, no surrounding blank space, the exact first and last line, no ChatML tag or Pi section tag, exactly rules 1 through 25, every `Rules N` reference resolving to a defined rule, the gate named inside each section that has to carry it, each exemption that stops an existing rule from firing on the gate path, the canonical confirm line, no `APPROVE` in the prompt and no test vocabulary in it, and the Chinese audit (data in the four sections that carry it, or quoted payload in a code span or a parenthesised gloss, and nowhere else). A drift guard fails when the stock preamble literal is missing from any installed Pi release.

It then drives the handlers `index.ts` registers: a DeepSeek run recording no section and no text, a seeded marker record removed for either model, the forced-prompt and unreadable-file reports. The gate is checked with `defaultActive: false`, its arguments run through Pi's own `validateToolArguments` (a loose list normalized, a stray key dropped, an empty call and a missing `fictional` reaching the ruling, an out-of-set code and a non-boolean `fictional` rejected), the coverage contract against the field table in both directions, one reason line per code, activation for DeepSeek and withdrawal for another model with one tool-set write per direction and none on a steady run, a loadout that filters the name locking after one attempt with a new session retrying, approval, denial, re-call and a rejected out-of-set code through `execute`, and the nested-call block.

Last come the per-request guard on its own (the text placed at the head, an aligned request left untouched, the identity sentence withheld from every system message while a custom preamble survives, an immutable caller transcript) and the same behaviour against the installed Pi: its own base prompt, both provider families' rendering, the section order, and the wire text for a model switch in either direction.

## Attribution

`prompt.md` is a modified copy of the DeepSeek Harness jailbreak prompt from [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge), Apache-2.0. See `NOTICE` and `LICENSE`.
