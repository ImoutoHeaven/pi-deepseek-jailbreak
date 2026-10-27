# pi-deepseek-jailbreak

Adds `<deepseek_policy>` to the system prompt while the session model is DeepSeek. Every other model runs with the stock Pi prompt.

| Session model | System prompt |
|---|---|
| DeepSeek (by model id or provider) | stock prompt plus `<deepseek_policy>` holding `prompt.md` |
| anything else | stock prompt only |

A model counts as DeepSeek when its id contains `deepseek` in any position (`deepseek-chat`, `~deepseek/deepseek-flash-latest`, `@cf/deepseek-ai/deepseek-v4-pro-0813`, `accounts/fireworks/models/deepseek-v4p1-flash`), or when the serving provider is named `deepseek`. Pi's catalogs serve DeepSeek ids through OpenRouter, Cloudflare, Fireworks, Bedrock, Baseten, Hugging Face and others, so an id prefix misses twelve shipped ids. The rule is deliberately permissive: an alias that merely contains `deepseek` while serving another model also receives the section.

## Install

This repository is the source of truth. `pi install ./pi-deepseek-jailbreak` records the package path in `~/.pi/agent/settings.json` and loads the files in place from that path: nothing is copied and nothing is built. `--local` writes the entry to the project `.pi/settings.json` instead, which Pi reads once project trust is granted.

```bash
pi install ./pi-deepseek-jailbreak
```

`pi -e ./index.ts` loads it for one run. The extension reads `prompt.md` through `import.meta.url` and imports `./model.js`, so both files travel with `index.ts`.

## Model switches

The section is decided at run start, so a model switch takes effect on the next run. The transcript keeps the prompt the run started with, and every request in that run, retries included, passes through the guard below, which corrects it for the live model without writing a delta.

Pi reuses the run-start prompt options for every turn of a run (`agent-session.js:543`) while sending the live model per turn (`:562`), so a mid-run switch would keep delivering the old state. The `context_with_system` guard repairs each request against the live model by appending one system message that adds or removes the section, and it returns undefined when the request already matches, leaving the bytes and the prefix cache untouched. The guard is request-only: the transcript keeps what the run recorded.

`deepseek-v4-pro` on the `deepseek` provider accepts mid-conversation system messages (`supportsMidConvoSystemMessages`) and receives the change framed as `Updated system prompt section "deepseek_policy":`. `deepseek-flash` has no such support, so Pi folds the section into the leading system message instead.

If another extension forces the system prompt, Pi renders no sections at all and the extension reports that the section is not delivered; the forced text wins.

The built section is ~25.7 kB ≈ 6.4k tokens on every DeepSeek request.

Injection is visible in the session log:

```bash
rg --fixed-strings '"deepseek_policy"' ~/.pi/agent/sessions
```

## Files

`index.ts` is the hook, `model.js` the model check, `prompt.md` the injected text. Edit `prompt.md`; the next run uses it. A missing or empty file is reported in the UI and injects nothing.

## Check

```bash
node check.mjs
```

Covers the model predicate against the catalog id shapes, the `prompt.md` invariants (LF only, no surrounding blank space, exact first and last line, no ChatML or forged section tags, every `Rules N` reference resolving to a defined rule), the handlers `index.ts` actually registers (injection for a DeepSeek id, removal and section preservation for another id, the forced-prompt warning reported once), the mid-run guard (aligned requests returning the same array, Pi's recorded `{ deepseek_policy: null }` steady state staying a no-op over repeated requests, add and remove deltas, placement, removal without a `prompt.md` snapshot, and the leading system message staying at index 0), and Pi's own section rendering and diff against the installed package. The package is resolved from `PI_PKG`, then the installed `@earendil-works/pi-coding-agent`, then `~/.pi/agent/install/releases/*`; a missing package fails the check instead of skipping it.

## Attribution

`prompt.md` is a modified copy of the DeepSeek Harness jailbreak prompt from [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge), Apache-2.0. See `NOTICE` and `LICENSE`.
