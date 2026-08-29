"use strict";

// docs/EVAL.md Layer 2 shape, shared across every command so the field
// set can't drift command-to-command the way build-guide.md drifted
// from live config (CLAUDE.md's Conventions note on that).
//
// costUsd is required, not computed here. It used to be derived from
// tokensIn/tokensOut via pricing.js's hardcoded Gemini-only rate table,
// which silently mispriced every non-Gemini call routed through this
// function -- every audit-stage (Fable 5) telemetry line was logged at
// Gemini's $0.75/$3.75-per-M rate instead of Fable's actual cost, found
// while building ops/conformance.py's C-02 check. Fixed at the source
// instead: llm.js/audit-llm.js now read LiteLLM's own
// x-litellm-response-cost response header (real, per-model, computed by
// LiteLLM itself) and return it as costUsd on every call, which callers
// pass straight through here. A caller that genuinely doesn't know the
// cost (a model call that threw before returning) passes 0, the honest
// value for "we don't know what the provider billed," not an invented
// estimate.
function buildEvalEvent({
	stage,
	founder,
	model = "flash-fast",
	ideaId = null,
	tokensIn = 0,
	tokensOut = 0,
	costUsd = 0,
	// Fraction of the LLM calls behind this event that LiteLLM served
	// from cache (0..1). Single-call events pass 0 or 1; multi-call
	// events (cross.js's two reads, retry loops) pass hits / calls. A
	// cached call is billed nothing, so cost_usd and cache_hit_ratio move
	// together -- ops/conformance.py C-23 cross-checks that.
	cacheHitRatio = 0,
	wallClockS = 0,
	verdict = null,
	evidenceBasis = null,
	reasonCode = null,
	status,
	// D-51: conversational-turn action-intent fields. Only appear on chat
	// / project_turn events (chat-turn.js passes them every turn, nulls
	// included, so an over-eager suggestion prompt is visible in telemetry
	// rather than degrading silently). undefined here -> omitted.
	suggestedAction,
	suggestionConfidence,
	regexAction,
	offerMade,
	offerAction,
	offerSuppressedReason,
	// ROOT CAUSE A: when a turn's intent was executed as a command
	// instead of answered in prose. executionSource is "regex" |
	// "model_high" | "offer_tap". discardedReply marks a prose reply the
	// model produced that we suppressed because the command owns it.
	executedAction,
	executionSource,
	discardedReply,
	// On an offer_tap event: the confidence the offer was made at, so
	// EVAL can see whether mediums get tapped (bar-too-low signal).
	offerTapConfidence,
	// D-52 amendment: was the turn phrased as a question, and did that
	// stop a route from firing ("interrogative"). Aggregated in EVAL to
	// catch over-eager routing without hunting one command at a time.
	interrogative,
	routingSuppressed,
}) {
	const event = {
		founder,
		stage,
		idea_id: ideaId,
		model,
		tokens_in: tokensIn,
		tokens_out: tokensOut,
		cache_hit_ratio: cacheHitRatio,
		cost_usd: costUsd,
		wall_clock_s: Math.round(wallClockS * 1000) / 1000,
		verdict,
		evidence_basis: evidenceBasis,
		reason_code: reasonCode,
		status,
	};
	if (offerMade !== undefined) {
		event.suggested_action = suggestedAction ?? null;
		event.suggestion_confidence = suggestionConfidence ?? null;
		event.regex_action = regexAction ?? null;
		event.offer_made = Boolean(offerMade);
		event.offer_action = offerAction ?? null;
		event.offer_suppressed_reason = offerSuppressedReason ?? null;
		event.executed_action = executedAction ?? null;
		event.execution_source = executionSource ?? null;
		event.discarded_reply = Boolean(discardedReply);
		event.interrogative = Boolean(interrogative);
		event.routing_suppressed = routingSuppressed ?? null;
	}
	if (offerTapConfidence !== undefined) {
		event.offer_action = offerAction ?? null;
		event.offer_tap_confidence = offerTapConfidence ?? null;
		event.execution_source = "offer_tap";
	}
	return event;
}

module.exports = { buildEvalEvent };
