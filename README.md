# pi-deepseek-jailbreak

Prepends the text of `prompt.md` to the system prompt while the session model is DeepSeek. Every other model runs with the stock Pi prompt.

| Session model | System prompt |
|---|---|
| DeepSeek (by model id or provider) | `prompt.md` text, then the stock Pi prompt without its opening identity sentence |
| anything else | stock Pi prompt only |

A model counts as DeepSeek when its id contains `deepseek` in any position (`deepseek-chat`, `~deepseek/deepseek-flash-latest`, `@cf/deepseek-ai/deepseek-v4-pro-0813`, `accounts/fireworks/models/deepseek-v4p1-flash`), or when the serving provider is named `deepseek`. Pi's catalogs serve DeepSeek ids through OpenRouter, Cloudflare, Fireworks, Bedrock, Baseten, Hugging Face and others, so an id prefix misses twelve shipped ids. The rule is deliberately permissive: an alias that merely contains `deepseek` while serving another model also receives the text.

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

The text is ~25.7 kB ≈ 6.4k tokens on every DeepSeek request.

## Files

`index.ts` is the hook, `model.js` the model check, `prompt.md` the injected text. Edit `prompt.md`; the next run uses it. A missing or empty file is reported in the UI and injects nothing.

## Check

```bash
node check.mjs
```

Covers the model predicate against the catalog id shapes, the `prompt.md` invariants (LF only, no surrounding blank space, exact first and last line, no ChatML or forged section tags, every `Rules N` reference resolving to a defined rule), a drift guard that the 169-character stock preamble literal still appears in every installed Pi release, the handlers `index.ts` actually registers (a DeepSeek run recording no section and no text, a seeded marker record removed for either model, other sections preserved, the forced-prompt warning reported once), the per-request guard (the text landing in the head content with no wrapper, the stock `preamble` withheld from every system message while the text is in force — including nodes after Pi's own prompt patch — while a custom prompt, a copied-and-extended default prompt and an embedded identity sentence all survive, an aligned request returning nothing for text alone, text with a trailing newline, a summary in front, text plus trailing content, and a single-text-block array, while the text lands only on `messages[0]` and never on a later system message, non-text head content left untouched, no mutation of the caller's transcript or its sections, marker records stripped whether they hold text or `null`, repeated requests not growing, a transcript without a leading system message, and the `prompt.md` fallback when no run-start snapshot exists), the rendered prompt through Pi's own `getSystemMessageText` and `collapseSystemMessages` (order, marker absence, identity sentence absent for DeepSeek and present for another model, byte-identical re-render), what both provider families put on the wire through `renderSystemMessageUpdate` (no `deepseek_policy` name, no removal notice, no identity sentence, custom prompt intact), and Pi's section builder and diff against the installed package. The package is resolved from `PI_PKG`, then the installed `@earendil-works/pi-coding-agent`, then `~/.pi/agent/install/releases/*`; a missing package fails the check instead of skipping it.

## Attribution

`prompt.md` is a modified copy of the DeepSeek Harness jailbreak prompt from [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge), Apache-2.0. See `NOTICE` and `LICENSE`.
