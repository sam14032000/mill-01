"use strict";

// Presenton Cloud — the RENDERING service for deck mode.
//
// Deliberately the structured-JSON flow (`/presentation/from-json`), not
// the prompt flow. Presenton offers both; the prompt flow would have its
// own LLM author the deck from a dump of the project's assets, which
// would make the deck persona decorative (its refusal would never fire)
// and would put a non-LiteLLM model in a request path authoring
// founder-facing content — the one thing D-43/D-53 keep out. Their docs
// frame the JSON flow exactly this way: "your application already owns
// the narrative and slide data... Presenton applies the chosen layouts
// and renders the presentation without planning the story from a prompt."
//
// Consequences of that choice, both deliberate:
//   * Standard templates only. `smart_design` composes adaptively and
//     cannot validate supplied content against fixed layout schemas, so
//     it is prompt-flow-only. Smart probably looks better; the price is
//     the persona not writing the deck. Do not "upgrade" to Smart without
//     realising it removes the persona from its own mode.
//   * Only the finished slide text leaves the box, not the asset set.
//     D-17 still applies — this is a deliberate exception, recorded in
//     DECISIONS — but the exposure is bounded.
//
// POLLING, not webhooks. Presenton offers generation-completed/failed
// webhooks, but consuming them needs an inbound HTTP endpoint and D-04 is
// explicit that nothing here opens one (the ngrok tunnel is outbound-only
// and reserved for the prototype mount slot).

const BASE_URL = (process.env.PRESENTON_BASE_URL || "https://api.presenton.ai/api/v3").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = Number(process.env.MILL_DECK_POLL_MS) || 5000;
const POLL_MAX_MS = Number(process.env.MILL_DECK_POLL_MAX_MS) || 10 * 60 * 1000;

function apiKey() {
	const key = process.env.PRESENTON_API_KEY;
	if (!key) throw new Error("PRESENTON_API_KEY not set — deck rendering is unavailable until an API key is configured");
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
				Authorization: `Bearer ${apiKey()}`,
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: controller.signal,
		});
	} catch (err) {
		if (err.name === "AbortError") throw new Error(`presenton: ${method} ${pathname} timed out after ${REQUEST_TIMEOUT_MS}ms`);
		throw err;
	} finally {
		clearTimeout(timeout);
	}
	const text = await res.text();
	if (!res.ok) throw new Error(`presenton: ${method} ${pathname} failed HTTP ${res.status} ${text.slice(0, 300)}`);
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`presenton: ${method} ${pathname} returned non-JSON: ${text.slice(0, 200)}`);
	}
}

// --- template discovery -------------------------------------------------
// Two calls: the list populates the picker, the detail carries each
// layout's live json_schema. The docs are explicit that schemas must be
// read live ("always use the live json_schema returned for the selected
// layout"), so they are never cached across renders.

async function listTemplates() {
	const json = await request("/standard-template/all");
	return (json.items || []).map((t) => ({
		id: t.id,
		name: t.name || t.id,
		layoutCount: t.layout_count ?? null,
		thumbnailUrl: t.thumbnail_url || null,
	}));
}

// Returns { id, name, layouts: [{ id, schema }] }.
async function getTemplate(templateId) {
	const json = await request(`/standard-template/${encodeURIComponent(templateId)}`);
	const schemas = json.schemas || json.layouts || [];
	return {
		id: json.id || templateId,
		name: json.name || templateId,
		layouts: schemas.map((s) => ({ id: s.title || s.id || s.name, schema: s })),
	};
}

// --- validation ---------------------------------------------------------
// Never ship unvalidated model JSON to a paid endpoint. Same discipline as
// commands/audit.js's parseAuditResponse: check shape in code, and treat a
// failure as a failure rather than hoping the vendor copes.

function validateSlides(slides, template) {
	if (!Array.isArray(slides) || slides.length === 0) return { ok: false, reason: "slides must be a non-empty array" };
	const known = new Map(template.layouts.map((l) => [l.id, l.schema]));
	for (const [i, slide] of slides.entries()) {
		if (!slide || typeof slide !== "object") return { ok: false, reason: `slide ${i} is not an object` };
		if (!slide.layout) return { ok: false, reason: `slide ${i} has no layout` };
		if (!known.has(slide.layout)) {
			return { ok: false, reason: `slide ${i} uses layout "${slide.layout}", which is not in template "${template.id}" (available: ${[...known.keys()].join(", ")})` };
		}
		if (!slide.content || typeof slide.content !== "object") return { ok: false, reason: `slide ${i} has no content object` };
		// Required-field check against the layout's live schema.
		const schema = known.get(slide.layout) || {};
		const required = schema.required || schema.schema?.required || [];
		for (const field of required) {
			if (!(field in slide.content)) {
				return { ok: false, reason: `slide ${i} (layout "${slide.layout}") is missing required field "${field}"` };
			}
		}
	}
	return { ok: true };
}

// --- generation ---------------------------------------------------------

async function startGeneration({ slides, templateId, title, exportAs = "pptx" }) {
	const json = await request("/presentation/from-json/async", {
		method: "POST",
		body: {
			standard_template: templateId, // never send smart_design alongside this
			slides,
			title,
			language: "en", // D-35: the mill is English-only
			export_as: exportAs,
		},
	});
	const taskId = json.task_id || json.id || json.taskId;
	if (!taskId) throw new Error(`presenton: no task id in response: ${JSON.stringify(json).slice(0, 200)}`);
	return taskId;
}

async function pollGeneration(taskId, { onTick = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
	const startedAt = Date.now();
	for (;;) {
		const json = await request(`/async-task/status/${encodeURIComponent(taskId)}`);
		const status = String(json.status || "").toLowerCase();
		if (onTick) onTick(status, json);
		if (status === "completed" || status === "success" || status === "succeeded") {
			return { ok: true, ...json };
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
	listTemplates,
	getTemplate,
	validateSlides,
	startGeneration,
	pollGeneration,
};
