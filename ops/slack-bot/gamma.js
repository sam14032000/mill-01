"use strict";

// Gamma Generate API — the RENDERING service for deck mode.
//
// `textMode` is the setting that decides who authors the deck, and it is
// a FOUNDER CHOICE per deck — never a silent default.
//
//   preserve — "keeps your supplied text as-is without AI rewriting".
//     The deck persona authors; Gamma only renders. Verified with nonsense
//     markers and clumsy sentences read back out of the PPTX.
//   generate — Gamma restructures the content into its own layouts.
//
// Measured, not assumed (both probes committed to ops/BUILD-LOG.md):
// generate KEPT every fact given to it (Shopify, WMS, 10-digit HTS,
// de-minimis, ops lead, threshold, shortfall all survived) and produced
// step-sequence flow layouts preserve cannot — restructuring prose into
// labelled boxes IS rewriting. It also cost 9 credits against 15. The
// price is register: it added "seamless", "purpose-built", "automated" —
// marketing prose nobody wrote. No invented facts; embellishment.
//
// So `preserve` stays the default (an evidence-bearing deck should say
// what the founder said) and `generate` is offered for decks where the
// visual structure is the point, with the trade named in the UI. What
// must never happen is textMode changing silently: that would make the
// persona decorative with nothing to reveal it.
//
// `cardSplit: "inputTextBreaks"` keeps slide boundaries ours too: Gamma
// splits at the markers in deck.md rather than deciding card breaks
// itself. Slide count is therefore a conversation with the persona, not
// an API parameter.
//
// What Gamma DOES decide is per-card layout and design — you cannot set
// them. That is a feature here rather than a limitation: per-slide layout
// was never a founder choice, so letting Gamma own it removes a whole
// pipeline (fetch live layout schemas -> emit schema-conforming JSON ->
// validate -> retry) and the failure class that came with it.
//
// Not available, and worth knowing: Gamma documents no embed or scoped
// share URL. `gammaUrl` is an editable link inside Gamma's own web app —
// the rich reorder/edit/preview surface Slack cannot be — but reaching it
// goes through Gamma's own permissions rather than a login-free token.
//
// POLLING, not webhooks: consuming webhooks needs an inbound HTTP
// endpoint, and D-04 is explicit that nothing here opens one (the ngrok
// tunnel is outbound-only and reserved for the prototype mount slot).

const BASE_URL = (process.env.GAMMA_BASE_URL || "https://public-api.gamma.app/v1.0").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = Number(process.env.MILL_DECK_POLL_MS) || 5000;
const POLL_MAX_MS = Number(process.env.MILL_DECK_POLL_MAX_MS) || 10 * 60 * 1000;

// Gamma caps inputText at 400k characters.
const MAX_INPUT_CHARS = 400_000;

function apiKey() {
	const key = process.env.GAMMA_API_KEY;
	if (!key) throw new Error("GAMMA_API_KEY not set — deck rendering is unavailable until an API key is configured");
	return key;
}

async function request(pathname, { method = "GET", body = null } = {}) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	let res;
	try {
		res = await fetch(`${BASE_URL}${pathname}`, {
			method,
			headers: {
				"X-API-KEY": apiKey(),
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: controller.signal,
		});
	} catch (err) {
		if (err.name === "AbortError") throw new Error(`gamma: ${method} ${pathname} timed out after ${REQUEST_TIMEOUT_MS}ms`);
		throw err;
	} finally {
		clearTimeout(timeout);
	}
	const text = await res.text();
	// Rate-limit headers exist for adaptive polling; surface them so the
	// caller can back off rather than hammering a paid endpoint.
	const rate = {
		burst: res.headers.get("x-ratelimit-remaining-burst"),
		remaining: res.headers.get("x-ratelimit-remaining"),
		daily: res.headers.get("x-ratelimit-remaining-daily"),
	};
	if (!res.ok) throw new Error(`gamma: ${method} ${pathname} failed HTTP ${res.status} ${text.slice(0, 300)}`);
	try {
		return { json: JSON.parse(text), rate };
	} catch {
		throw new Error(`gamma: ${method} ${pathname} returned non-JSON: ${text.slice(0, 200)}`);
	}
}

// deck.md is authored by the persona as one section per slide. Gamma
// splits on the markers we pass with cardSplit:"inputTextBreaks" — a
// horizontal rule is the unambiguous, human-readable break, and it
// already renders as a divider in the committed markdown.
const SLIDE_BREAK = "\n---\n";

function slideCount(inputText) {
	return String(inputText || "").split(/^\s*---\s*$/m).filter((s) => s.trim()).length;
}

async function listThemes() {
	const { json } = await request("/themes");
	const items = json.items || json.themes || json.data || [];
	return items.map((t) => ({
		id: t.id || t.themeId || t.name,
		name: t.name || t.title || t.id,
		thumbnailUrl: t.thumbnailUrl || t.thumbnail_url || t.previewUrl || null,
	}));
}

// Starts a generation. `inputText` is deck.md verbatim — never a summary
// of it, and never a prompt describing what to make.
// Image sources, from Gamma's own list. Ordered by what this system
// should default to rather than by what looks best.
//
// Gamma adds imagery on its own — verified by unzipping a rendered deck:
// one photo per slide appeared with no imageOptions sent at all. Leaving
// that unpinned is two risks. Cost: `aiGenerated` bills 2–125 credits PER
// IMAGE by model tier, so a 12-slide deck could run 900+ credits against a
// 4,000/month allowance, versus ~60 with stock. And fabrication: the deck
// persona refuses on audience, not on evidence (D-56), so imagery is the
// one place an unearned claim can reach a founder-facing artifact.
const IMAGE_SOURCES = {
	stock: "webFreeToUseCommercially", // real photos, cleared for commercial use, 0 credits
	pexels: "pexels",
	none: "noImages",
	ai: "aiGenerated", // invents imagery; 2–125 credits each
};
const DEFAULT_IMAGE_SOURCE = IMAGE_SOURCES.stock;

const TEXT_MODES = { preserve: "preserve", generate: "generate" };
const DEFAULT_TEXT_MODE = TEXT_MODES.preserve;

async function startGeneration({ inputText, themeId = null, exportAs = "pptx", title = null, additionalInstructions = null, imageSource = DEFAULT_IMAGE_SOURCE, textMode = DEFAULT_TEXT_MODE }) {
	const body = {
		inputText: String(inputText).slice(0, MAX_INPUT_CHARS),
		// The two settings that keep authorship ours. Do not change these
		// without re-reading this module's header.
		textMode,
		// Only meaningful under preserve; in generate mode Gamma decides breaks.
		...(textMode === TEXT_MODES.preserve ? { cardSplit: "inputTextBreaks" } : {}),
		format: "presentation",
		exportAs,
		...(themeId ? { themeId } : {}),
		// Always explicit — never Gamma's unstated default.
		imageOptions: { source: imageSource },
		...(title ? { title: String(title).slice(0, 500) } : {}),
		...(additionalInstructions ? { additionalInstructions: String(additionalInstructions).slice(0, 5000) } : {}),
	};
	const { json } = await request("/generations", { method: "POST", body });
	const id = json.generationId || json.id;
	if (!id) throw new Error(`gamma: no generationId in response: ${JSON.stringify(json).slice(0, 200)}`);
	return id;
}

function normaliseResult(json) {
	const credits = json.credits || {};
	return {
		gammaId: json.gammaId || json.id || null,
		// Gamma's own editable web app: the reorder/edit/preview surface
		// Slack cannot provide. No scoped/login-free variant is documented.
		editUrl: json.gammaUrl || json.gammaURL || null,
		downloadUrl: json.exportUrl || json.exportURL || null,
		creditsDeducted: credits.deducted ?? json.creditsDeducted ?? null,
		creditsRemaining: credits.remaining ?? json.creditsRemaining ?? null,
	};
}

async function pollGeneration(generationId, { onTick = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
	const startedAt = Date.now();
	for (;;) {
		const { json } = await request(`/generations/${encodeURIComponent(generationId)}`);
		const status = String(json.status || "").toLowerCase();
		if (onTick) onTick(status, json);
		if (status === "completed" || status === "succeeded" || status === "success") {
			return { ok: true, ...normaliseResult(json), raw: json };
		}
		if (status === "failed" || status === "error") {
			return { ok: false, reason: json.error || json.message || "generation failed", raw: json };
		}
		if (Date.now() - startedAt > POLL_MAX_MS) {
			return { ok: false, reason: `generation still ${status || "pending"} after ${Math.round(POLL_MAX_MS / 1000)}s` };
		}
		await sleep(POLL_INTERVAL_MS);
	}
}

module.exports = {
	BASE_URL,
	IMAGE_SOURCES,
	DEFAULT_IMAGE_SOURCE,
	TEXT_MODES,
	DEFAULT_TEXT_MODE,
	SLIDE_BREAK,
	MAX_INPUT_CHARS,
	slideCount,
	listThemes,
	startGeneration,
	pollGeneration,
	normaliseResult,
};
