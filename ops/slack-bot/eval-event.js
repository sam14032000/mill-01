"use strict";

const { geminiFlashCost } = require("./pricing");

// docs/EVAL.md Layer 2 shape, shared across every command so the field
// set can't drift command-to-command the way build-guide.md drifted
// from live config (CLAUDE.md's Conventions note on that).
function buildEvalEvent({
	stage,
	founder,
	model = "flash-fast",
	ideaId = null,
	tokensIn = 0,
	tokensOut = 0,
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
		cost_usd: geminiFlashCost({ tokensIn, tokensOut }),
		wall_clock_s: Math.round(wallClockS * 1000) / 1000,
		verdict,
		evidence_basis: evidenceBasis,
		reason_code: reasonCode,
		status,
	};
}

module.exports = { buildEvalEvent };
