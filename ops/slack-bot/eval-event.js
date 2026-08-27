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
	wallClockS = 0,
	verdict = null,
	evidenceBasis = null,
	reasonCode = null,
	status,
}) {
	return {
		founder,
		stage,
		idea_id: ideaId,
		model,
		tokens_in: tokensIn,
		tokens_out: tokensOut,
		cache_hit_ratio: 0.0,
		cost_usd: costUsd,
		wall_clock_s: Math.round(wallClockS * 1000) / 1000,
		verdict,
		evidence_basis: evidenceBasis,
		reason_code: reasonCode,
		status,
	};
}

module.exports = { buildEvalEvent };
