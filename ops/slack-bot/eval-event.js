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
	// Agent-loop fields (agent.js), on `chat` / `project_turn` events.
	// The old D-51/D-52 intent-classifier fields (suggested_action,
	// confidence, regex_action, offer_*, interrogative, routing_suppressed,
	// executed_action) are gone with the classifier -- the agent decides,
	// and what it did is: which tool(s) it called (or none), how many
	// model steps, whether it replied without a tool.
	toolsCalled,
	toolsIgnored,
	iterations,
	repliedWithoutTool,
	// Phase 2: /proto's inner build loop -- how many sandbox
	// build/fix/re-run attempts, and whether it ended up running clean.
	buildIterations,
	buildSucceeded,
	// D-53 research modes: who initiated a web search this event covers --
	// "agent" (inline quick fact check) | "founder" (/find, @Mill find, or
	// the agent's broad mode because the founder asked). EVAL Layer 2
	// watches the agent-initiated rate.
	searchInitiatedBy,
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
	if (toolsCalled !== undefined) {
		event.tools_called = Array.isArray(toolsCalled) ? toolsCalled : [];
		event.tools_ignored = toolsIgnored ?? 0;
		event.iterations = iterations ?? 1;
		event.replied_without_tool = Boolean(repliedWithoutTool);
	}
	if (buildIterations !== undefined) {
		event.build_iterations = buildIterations ?? 0;
		event.build_succeeded = buildSucceeded ?? null;
	}
	if (searchInitiatedBy !== undefined) {
		event.search_initiated_by = searchInitiatedBy ?? null;
	}
	return event;
}

module.exports = { buildEvalEvent };
