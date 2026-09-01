"use strict";

// Shared helpers for the command layer. The old regex + confidence
// classifier that lived here (D-51/D-52) is gone -- a founder thinking
// out loud in a thread is now handled by the agent loop (agent.js),
// which gets the tool set + thread context and decides for itself
// whether to run a command or just reply. What's left here:
//
//   ACTIONS / PROJECT_ONLY  -- the command set and which need a project
//   parseMention            -- `@Mill <cmd>` still bypasses the agent
//   validateSuggestion      -- idea-state preconditions, now used by the
//                              tool adapters (tools.js) as a fast check
//                              before invoking a handler; the handler's
//                              own gate is still the real enforcement
//   composeIdeaInput        -- merge the invoking text with thread context
//   isAnaphoric             -- /find's anaphora resolver (commands/find.js)

const ACTIONS = ["attack", "find", "cross", "blindspot", "themes", "test", "proto", "spinoff", "audit", "save"];

// Actions that need a project (not usable in a bare #chats session).
const PROJECT_ONLY = new Set(["test", "proto", "spinoff", "audit", "save"]);

// The `@Mill <word> ...` form. First word after the mention, mapped to an
// action. Returns { action, rest } or null. Deliberate invocation --
// does not go through the agent.
const MENTION_ALIASES = {
	attack: "attack", find: "find", search: "find", think: "think", develop: "think",
	cross: "cross", blindspot: "blindspot", themes: "themes", theme: "themes",
	test: "test", research: "test", audit: "audit", gate: "audit",
	proto: "proto", prototype: "proto", spinoff: "spinoff", "spin-off": "spinoff",
	// Change 1: mode is a control action, not an idea-lifecycle command --
	// handled directly in index.js rather than through command-shim's
	// HANDLERS map.
	mode: "mode", switch: "mode",
	// `@Mill save` writes the current mode's document from the conversation.
	save: "save", write: "save",
	// `@Mill deck` posts the render control for the current chat.
	deck: "deck", render: "deck",
	// `@Mill chat <title>` opens a new chat inside a project channel.
	chat: "chat", newchat: "chat",
};
function parseMention(textAfterMention) {
	const m = String(textAfterMention || "").trim().match(/^(\S+)\s*([\s\S]*)$/);
	if (!m) return null;
	const action = MENTION_ALIASES[m[1].toLowerCase()];
	if (!action) return null;
	return { action, rest: m[2].trim() };
}

// A message that only makes sense against the conversation it sits in --
// "research these", "look this up". /find resolves the subject from
// thread context before planning queries when this matches.
const ANAPHORIC_RE =
	/\b(these|this|that|those|it|them|the (?:above|following|idea|problem|problems|assumption|point|points|thing|things))\b|\bwhat (?:we|you|i) (?:just )?(?:discussed|said|talked about|covered|mentioned)\b|\bthe (?:same|other) (?:one|thing)\b/i;

function isAnaphoric(text, { minStandaloneWords = 6 } = {}) {
	const t = String(text || "").trim();
	if (!t) return true;
	if (ANAPHORIC_RE.test(t)) return true;
	return t.split(/\s+/).length < minStandaloneWords;
}

// A brainstorm command invoked from a thread ("attack this", "let's
// start by attacking it") must not judge the idea against that trailing
// message alone -- the mechanism / customer / incumbent are in the
// thread and origin-chat.md. When thread context is present, the idea IS
// the conversation; the trailing message is a pointer into it, added
// only if it carries content of its own.
function composeIdeaInput(text, threadContext) {
	const t = String(text || "").trim();
	if (!threadContext || !threadContext.trim()) return t;
	if (!t || isAnaphoric(t)) {
		return `${threadContext}\n\n---\n(The idea to work on is the one in the conversation above.)`;
	}
	return `${threadContext}\n\n---\nThe founder's latest message: ${t}\n\n(Work on the idea in the conversation above, focused by that message.)`;
}

// Does this action apply to the idea right now? `ctx` = { inChats,
// project (state obj or null), assumption, research (readLatestResearch
// result or null) }. Returns { ok: true } or { ok: false, reason }.
// The tool adapters call this to give the agent a usable "can't do that
// yet, because X" instead of invoking a handler that will refuse; the
// handler's own gate still fires regardless of caller.
function validateSuggestion(action, ctx) {
	if (!ACTIONS.includes(action)) return { ok: false, reason: "unknown_action" };
	if (ctx.inChats && PROJECT_ONLY.has(action)) return { ok: false, reason: "needs_project" };

	const state = ctx.project?.state;
	if (state === "killed" && action !== "spinoff") return { ok: false, reason: "idea_killed" };

	if (action === "test") {
		if (!ctx.assumption) return { ok: false, reason: "no_assumption" };
		if (state && !["open", "researched"].includes(state)) return { ok: false, reason: "wrong_state" };
	}
	if (action === "audit") {
		if (!ctx.research) return { ok: false, reason: "no_research" };
		if (ctx.research.json && ctx.research.json.research_stub !== false) return { ok: false, reason: "research_stub" };
		if (state && state !== "researched") return { ok: false, reason: "not_researched" };
	}
	if (action === "proto") {
		if ((ctx.project?.touch_count ?? 0) >= 5) return { ok: false, reason: "touch_cap" };
	}
	return { ok: true };
}

// Human-readable version of a validateSuggestion reason, for the agent
// to relay to the founder.
const REASON_MESSAGE = {
	unknown_action: "that isn't one of my commands",
	needs_project: "that needs a project — this is a plain chat",
	idea_killed: "this idea is killed; that verdict doesn't get worked around",
	no_assumption: "there's no named assumption yet — run `attack` first",
	wrong_state: "the idea isn't in a state where that applies",
	no_research: "no research has run yet — run `test` first",
	research_stub: "the research on file is a stub (Part 11 isn't built), so there's nothing to rule on",
	not_researched: "the idea hasn't been researched yet",
	touch_cap: "the five-touch cap is reached",
};

module.exports = {
	ACTIONS,
	PROJECT_ONLY,
	parseMention,
	validateSuggestion,
	REASON_MESSAGE,
	composeIdeaInput,
	isAnaphoric,
	ANAPHORIC_RE,
};
