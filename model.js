/**
 * DeepSeek check on the session model id or provider.
 *
 * Catalog ids do not all start with "deepseek": OpenRouter serves
 * `~deepseek/deepseek-flash-latest`, Cloudflare `@cf/deepseek-ai/...`, Fireworks
 * `accounts/fireworks/models/deepseek-v4p1-flash`. A substring match on the id and an
 * exact provider match cover every one of them, and a proxy alias that merely contains
 * the name still resolves to a DeepSeek model.
 */
export function isDeepSeekModel(model) {
	const id = String(model?.id ?? "").trim().toLowerCase();
	if (id.includes("deepseek")) return true;
	const provider = String(model?.provider ?? "").trim().toLowerCase();
	return provider === "deepseek";
}
