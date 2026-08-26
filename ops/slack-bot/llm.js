"use strict";

const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://127.0.0.1:4000";

// Root cause of the multi-minute latency hit while building /attack
// turned out to be a disabled API on the Google Cloud project, not
// thinking_level, not LiteLLM, not this timeout. That surfaced as slow
// hangs rather than an error, so several plausible-looking explanations
// (LiteLLM param-mapping bugs, network/cache issues) got built and ruled
// out before an out-of-stack test in AI Studio isolated it -- see
// ops/BUILD-LOG.md. Confirmed post-fix: a trivial prompt on flash-fast
// completes in ~3-4s. This timeout stays as a genuine safety bound, not
// a workaround for the old latency.
const REQUEST_TIMEOUT_MS = 120_000;

// D-08 amendment (docs/DECISIONS.md): Gemini 3.x bills internal
// reasoning as output tokens and defaults to thinking_level "high" when
// unspecified. LiteLLM config (~/stack/litellm/config.yaml) splits this
// into two model entries -- "flash-fast" (thinking_level: low, for
// interactive commands) and "flash" (thinking_level: medium, for
// research) -- never unspecified. D-10 is absolute regardless: audit
// (Fable 5, MILL_AUDIT_KEY) is never called from here.
//
// Gemini 3.x rejects temperature/top_p/top_k -- deliberately not
// exposed as options here so no caller can accidentally send them.
async function callFlash(messages, { model = "flash", maxTokens = 4096 } = {}) {
	const key = process.env.MILL_FLASH_KEY;
	if (!key) throw new Error("MILL_FLASH_KEY not set");

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	let res;
	try {
		res = await fetch(`${LITELLM_BASE_URL}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model,
				messages,
				max_tokens: maxTokens,
			}),
			signal: controller.signal,
		});
	} catch (err) {
		if (err.name === "AbortError") {
			throw new Error(`${model} call timed out after ${REQUEST_TIMEOUT_MS}ms`);
		}
		throw err;
	} finally {
		clearTimeout(timeout);
	}

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`${model} call failed: HTTP ${res.status} ${body.slice(0, 300)}`);
	}

	const data = await res.json();
	const content = data.choices?.[0]?.message?.content;
	if (typeof content !== "string" || !content.trim()) {
		throw new Error(`${model} call returned no content`);
	}
	return { content, usage: data.usage };
}

module.exports = { callFlash };
