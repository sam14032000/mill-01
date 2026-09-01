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
// Research and interactive commands also split budgets (D-23 amendment,
// docs/DECISIONS.md): a single research pass costs roughly as much as
// 250 interactive exchanges, so sharing one key's daily cap would let
// one /test starve every founder's brainstorming for the rest of the
// day. mill-flash is scoped to flash-fast only; mill-research is scoped
// to flash only. Keyed off the model name here, not left to the caller
// to get right, so it's structurally impossible to route a call through
// the wrong budget.
const KEY_ENV_BY_MODEL = {
	"flash-fast": "MILL_FLASH_KEY",
	flash: "MILL_RESEARCH_KEY",
};

// D-08's amendment is explicit: Gemini 3.x bills internal reasoning as
// output tokens, so `max_tokens` is a budget the ANSWER shares with the
// thinking, and it must be at least 4096 wherever reasoning is enabled --
// "a low cap can leave nothing for the answer at all".
//
// That rule was recorded and then violated in eight call sites, and it
// cost a founder a working turn: the persona's refusal check ran with
// maxTokens 700, spent 675 of them reasoning, and the refusal was cut off
// mid-sentence before it could write the `UNBLOCK:` line its own contract
// requires. What reached the thread was a bare accusation with no way
// forward. The same call at 4096 produces the complete, specific refusal.
//
// A convention that has to be remembered at every call site is not a
// guard, so the floor is enforced here instead. Raising a cap costs
// nothing when the answer is short -- billing is per token generated, not
// per token allowed -- while a cap set too low fails silently, which is
// the asymmetry that decides it.
const MIN_MAX_TOKENS = Number(process.env.MILL_MIN_MAX_TOKENS) || 4096;
const flooredSites = new Set();
function floorMaxTokens(maxTokens, label) {
	if (maxTokens >= MIN_MAX_TOKENS) return maxTokens;
	// Log once per site, so this is visible without spamming a chatty loop.
	const site = new Error().stack.split("\n")[3] || label;
	if (!flooredSites.has(site)) {
		flooredSites.add(site);
		console.warn(`llm: raised max_tokens ${maxTokens} -> ${MIN_MAX_TOKENS} (reasoning shares the budget, D-08) at${site.replace(/^\s*at/, "")}`);
	}
	return MIN_MAX_TOKENS;
}


// Gemini 3.x rejects temperature/top_p/top_k -- deliberately not
// exposed as options here so no caller can accidentally send them.
// The abort timer must stay armed until the BODY is fully read.
//
// fetch() resolves when response HEADERS arrive, not when the body is
// complete. Clearing the timer in a finally around the fetch therefore
// disarms it at exactly the wrong moment: if the body then stalls -- which
// a proxied LLM response can do -- the subsequent res.json()/res.text()
// awaits with no abort armed and hangs forever.
//
// Found live: a founder's message sat on "_Thinking…_" for 3h40m. The
// process was idle, nothing was logged, and no telemetry was emitted,
// because the turn never reached ANY exit -- it was parked on a body read
// that could not time out. This affected every model call in the system,
// not one code path.
async function callFlash(messages, { model = "flash-fast", maxTokens = 4096 } = {}) {
	const keyEnvVar = KEY_ENV_BY_MODEL[model];
	if (!keyEnvVar) {
		throw new Error(`callFlash: no key mapping for model "${model}"`);
	}
	const key = process.env[keyEnvVar];
	if (!key) throw new Error(`${keyEnvVar} not set`);

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
				max_tokens: floorMaxTokens(maxTokens, "callFlash"),
			}),
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timeout);
		if (err.name === "AbortError") {
			throw new Error(`${model} call timed out after ${REQUEST_TIMEOUT_MS}ms`);
		}
		throw err;
	}

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		clearTimeout(timeout);
		throw new Error(`${model} call failed: HTTP ${res.status} ${body.slice(0, 300)}`);
	}

	// LiteLLM computes real per-model cost itself and returns it in this
	// header on every response -- ground truth, not a hardcoded price
	// table (see eval-event.js/pricing.js, which used to guess at cost
	// from tokens_out using Gemini-only rates and silently mispriced
	// every other model routed through this same function).
	//
	// BUT: on a cache hit LiteLLM still returns the *would-be uncached*
	// price in that header, while billing nothing (x-litellm-key-spend is
	// unchanged across a hit -- verified against /spend/logs). Trusting
	// the header on a hit over-reports cost on every cached call, and the
	// brainstorm prefix is deliberately built around caching (CLAUDE.md
	// pitfalls), so cached calls are the common case, not the rare one.
	// x-litellm-cache-key is present only when the response was served
	// from cache. Record what was actually billed: zero.
	const cacheHit = res.headers.get("x-litellm-cache-key") != null;
	const costUsd = cacheHit
		? 0
		: Number.parseFloat(res.headers.get("x-litellm-response-cost")) || 0;

	// Body read happens with the timer STILL ARMED (see note above).
	let data;
	try {
		data = await res.json();
	} catch (err) {
		if (err.name === "AbortError") throw new Error(`${model} response body stalled past ${REQUEST_TIMEOUT_MS}ms`);
		throw err;
	} finally {
		clearTimeout(timeout);
	}
	const content = data.choices?.[0]?.message?.content;
	if (typeof content !== "string" || !content.trim()) {
		// Real tokens (often real reasoning cost) were still spent even
		// when the model emits no visible text -- attach usage/costUsd to
		// the error so a caller that treats this as a valid outcome (only
		// profile-evolution.js does, see callFlashForDiff) can still
		// record accurate spend instead of defaulting to 0.
		const err = new Error(`${model} call returned no content`);
		err.usage = data.usage;
		err.costUsd = costUsd;
		err.cacheHit = cacheHit;
		throw err;
	}
	return { content, usage: data.usage, costUsd, cacheHit };
}

// Tool-calling variant for the agent loop (agent.js). Same auth / cost /
// timeout handling as callFlash, but passes `tools`/`tool_choice` and
// returns the raw assistant message (which may carry `tool_calls`
// instead of, or alongside, `content`) plus `finish_reason`. Unlike
// callFlash it does NOT throw on empty content -- a tool_calls response
// legitimately has no content.
async function callFlashTools(messages, { model = "flash-fast", maxTokens = 2048, tools, toolChoice = "auto" } = {}) {
	const keyEnvVar = KEY_ENV_BY_MODEL[model];
	if (!keyEnvVar) throw new Error(`callFlashTools: no key mapping for model "${model}"`);
	const key = process.env[keyEnvVar];
	if (!key) throw new Error(`${keyEnvVar} not set`);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	let res;
	try {
		res = await fetch(`${LITELLM_BASE_URL}/chat/completions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages,
				max_tokens: floorMaxTokens(maxTokens, "callFlash"),
				...(tools && tools.length ? { tools, tool_choice: toolChoice } : {}),
			}),
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timeout);
		if (err.name === "AbortError") throw new Error(`${model} tool call timed out after ${REQUEST_TIMEOUT_MS}ms`);
		throw err;
	}

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		clearTimeout(timeout);
		throw new Error(`${model} tool call failed: HTTP ${res.status} ${body.slice(0, 300)}`);
	}

	const cacheHit = res.headers.get("x-litellm-cache-key") != null;
	const costUsd = cacheHit ? 0 : Number.parseFloat(res.headers.get("x-litellm-response-cost")) || 0;

	// Timer stays armed through the body read -- see the note on callFlash.
	let data;
	try {
		data = await res.json();
	} catch (err) {
		if (err.name === "AbortError") throw new Error(`${model} response body stalled past ${REQUEST_TIMEOUT_MS}ms`);
		throw err;
	} finally {
		clearTimeout(timeout);
	}
	const choice = data.choices?.[0] || {};
	const msg = choice.message || {};
	return {
		content: typeof msg.content === "string" ? msg.content : null,
		toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
		finishReason: choice.finish_reason || null,
		usage: data.usage,
		costUsd,
		cacheHit,
	};
}

module.exports = { callFlash, callFlashTools };
