"use strict";

// Command-intent detection for conversational turns (D-51). Slash
// commands don't work inside Slack threads, so a founder thinking out
// loud reaches the brainstorm/project actions three ways: a slash command
// from the channel body, `@Mill <cmd>` in the thread (immediate), or by
// phrasing it in a normal message and tapping the offer this module
// produces.
//
// Two detectors feed the offer:
//   1. REGEX_INTENT -- unambiguous imperative phrasing, so "attack this"
//      never depends on model judgement. Fast, zero cost.
//   2. the conversational reply call's structured trailer (see
//      chat-turn.js) -- better recall than a regex list, no extra call.
// The offer only renders after validateSuggestion() confirms the action
// actually applies to the idea's current state.

// The fixed option set the model is told about and the regex maps into.
const ACTIONS = ["attack", "find", "cross", "blindspot", "themes", "test", "proto", "spinoff", "audit"];

// Actions that need a project (never offered in a bare #chats session).
const PROJECT_ONLY = new Set(["test", "proto", "spinoff", "audit"]);

// High-precision: an imperative aimed at *this idea now*, at the start of
// the message or a clause. Narration ("someone could attack this on
// price", "I searched already", "the counterargument is obvious") must
// NOT match -- it describes, it doesn't ask. The regex is deliberately
// conservative: a miss just falls through to the model's structured
// suggestion; a false positive on narration is the worse failure (it
// trains founders to ignore offers). Anchoring an imperative verb to a
// clause boundary and forbidding a preceding modal/subject
// ("could/would/might/someone/you could") is what buys that.
const CLAUSE_START = "(?:^|[.!?…]\\s+|\\bnow\\s+|\\bok(?:ay)?[,\\s]+|\\bso[,\\s]+|\\bplease\\s+|\\bcan you\\s+|\\bcould you\\s+|\\blet'?s\\s+|\\bgo ahead and\\s+)";
// "you could" / "we should" are already caught by could/should; leaving
// bare "you"/"we" out so a request framing ("can you attack this") isn't
// mistaken for narration.
const NOT_NARRATED = "(?<!\\b(?:could|would|might|should|someone|somebody|one|they|he|she)\\s)";
const RX = (body, flags = "i") => new RegExp(body, flags);

const REGEX_INTENT = [
	[RX(`${CLAUSE_START}${NOT_NARRATED}(attack|steel[- ]?man the case against|make the case against|poke holes in|argue against)\\s+(this|that|it|the idea)\\b`), "attack"],
	[RX(`${CLAUSE_START}(search|look\\s+up|find|google|check online)\\s+(for\\s+|the\\s+|whether\\s+|if\\s+|about\\s+|out\\s+)`), "find"],
	[RX(`${CLAUSE_START}(research this|test this assumption|run (a\\s+)?research pass)\\b`), "test"],
	[RX(`${CLAUSE_START}(prototype this|mock this up|build a (quick\\s+)?(mock|landing\\s?page|prototype|one[- ]?pager))`), "proto"],
	[RX(`${CLAUSE_START}spin (this\\s+)?(off|out)\\b|${CLAUSE_START}make this (its own|a separate)\\b`), "spinoff"],
	[RX(`${CLAUSE_START}(audit this|send this to the (gate|audit))\\b|\\bis this ready for the gate\\b`), "audit"],
	// Question-shaped -- hard to say incidentally, kept looser.
	[RX(`\\b(what would|how would)\\s+(the\\s+)?(others|amisha|vaibhav|saksham|the team|everyone else)\\s+(say|think|react)`), "cross"],
	[RX(`${CLAUSE_START}(run|bounce)\\s+(this|it|that)\\s+(past|by|off)\\s+(the\\s+)?(others|team)`), "cross"],
	[RX(`\\b(what'?s|where'?s)\\s+(the\\s+|our\\s+)?(shared\\s+)?blind\\s?spot\\b|\\bwhat are we (all\\s+)?missing\\b`), "blindspot"],
	[RX(`${CLAUSE_START}(show my themes|what have i been circling)\\b|\\brecurring (preoccupations|themes)\\b`), "themes"],
];

// A message that only makes sense against the conversation it sits in --
// "research these", "look this up", "what we just discussed". A command
// built from the raw text of one of these searches for the wrong thing
// (ROOT CAUSE B): /find on "research the existence of these problem
// statements" planned queries about validation methodology because
// "these" was never resolved. When this matches (or the text is too
// thin to stand alone), the command resolves its subject from thread
// context first.
const ANAPHORIC_RE =
	/\b(these|this|that|those|it|them|the (?:above|following|idea|problem|problems|assumption|point|points|thing|things))\b|\bwhat (?:we|you|i) (?:just )?(?:discussed|said|talked about|covered|mentioned)\b|\bthe (?:same|other) (?:one|thing)\b/i;

function isAnaphoric(text, { minStandaloneWords = 6 } = {}) {
	const t = String(text || "").trim();
	if (!t) return true;
	if (ANAPHORIC_RE.test(t)) return true;
	// Very short asks ("look into pricing", "find competitors") also lean
	// on the surrounding conversation for what they're about.
	return t.split(/\s+/).length < minStandaloneWords;
}

// A turn whose main clause is a question -- recall or clarification, not
// an instruction. Found live: "Didn't we also remedy the MoR solution by
// considering a layer of automation..." was classified as /attack and
// ran a full prosecution. The signal is a question word LEADING the turn
// (after filler like "so"/"ok"/"wait"), not a trailing "?" -- "attack
// this, what's the strongest case?" leads with an imperative and still
// routes.
const QUESTION_LEAD =
	/^(?:\s*(?:so|but|and|ok(?:ay)?|hmm+|well|wait|also|actually|hey|right|now)[,\s]+)*(?:who|what|what'?s|whats|when|where|why|how|how'?s|which|whose|whom|did|didn'?t|do|does|doesn'?t|don'?t|is|isn'?t|are|aren'?t|was|wasn'?t|were|weren'?t|have|haven'?t|has|hasn'?t|had|hadn'?t|will|won'?t|would|wouldn'?t|should|shouldn'?t|shall|could|couldn'?t|can|can'?t|cannot|may|might)\b/i;

function isInterrogative(text) {
	return QUESTION_LEAD.test(String(text || "").trim());
}

// The one carve-out: a question that explicitly asks to RUN a command.
// "can you attack this?", "could you search for X?", "would you run the
// audit?" -- these route despite the question form.
const EXPLICIT_RUN_REQUEST =
	/^(?:\s*(?:so|but|ok(?:ay)?|hey|please)[,\s]+)*(?:can|could|would|will|pls|please|are you able to)\s+(?:you\s+)?(?:please\s+)?(?:go ahead and\s+|just\s+)?(?:attack|steel[- ]?man|poke holes|argue against|make the case against|search|look up|find|google|research|test|pressure[- ]?test|prototype|mock (?:it|this) up|build (?:a|the)|audit|gate this|cross|run (?:this|it|that) (?:past|by)|bounce (?:this|it) off|spin (?:this|it)?\s*(?:off|out))/i;

function isExplicitRunRequest(text) {
	return EXPLICIT_RUN_REQUEST.test(String(text || "").trim());
}

// Should a detected intent actually be EXECUTED, given how the turn is
// phrased? A question doesn't route unless it explicitly asks to run
// something. "When in doubt, converse." (Offers are still allowed --
// this only gates auto-execution.)
function shouldRouteToCommand(text) {
	if (isExplicitRunRequest(text)) return true;
	return !isInterrogative(text);
}

// ROOT CAUSE B, in the commands it matters most for. A brainstorm command
// invoked from a thread ("attack this", "let's start by attacking it")
// judged vagueness against that trailing message alone -- ignoring the
// mechanism / customer / incumbent laid out in the thread and
// origin-chat.md. When thread context is present, the idea IS the
// conversation; the trailing message is a pointer into it, added only if
// it carries content of its own.
function composeIdeaInput(text, threadContext) {
	const t = String(text || "").trim();
	if (!threadContext || !threadContext.trim()) return t;
	if (!t || isAnaphoric(t)) {
		return `${threadContext}\n\n---\n(The idea to work on is the one in the conversation above.)`;
	}
	return `${threadContext}\n\n---\nThe founder's latest message: ${t}\n\n(Work on the idea in the conversation above, focused by that message.)`;
}

// Returns { action, source: "regex" } or null.
function detectRegexIntent(text) {
	const t = String(text || "");
	for (const [re, action] of REGEX_INTENT) {
		if (re.test(t)) return { action, source: "regex" };
	}
	return null;
}

// The `@Mill <word> ...` form. First word after the mention, mapped to an
// action. Returns { action, rest } or null.
const MENTION_ALIASES = {
	attack: "attack", find: "find", search: "find", think: "think", develop: "think",
	cross: "cross", blindspot: "blindspot", themes: "themes", theme: "themes",
	test: "test", research: "test", audit: "audit", gate: "audit",
	proto: "proto", prototype: "proto", spinoff: "spinoff", "spin-off": "spinoff",
};
function parseMention(textAfterMention) {
	const m = String(textAfterMention || "").trim().match(/^(\S+)\s*([\s\S]*)$/);
	if (!m) return null;
	const action = MENTION_ALIASES[m[1].toLowerCase()];
	if (!action) return null;
	return { action, rest: m[2].trim() };
}

// Does this action apply to the idea right now? (The risk the founder
// flagged: the model may suggest /audit before research, /proto on a
// killed idea.) `ctx` = { inChats, project (state obj or null), assumption,
// research (readLatestResearch result or null) }.
// Returns { ok: true } or { ok: false, reason: "<slug>" }.
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

// Parse the `---MILL-ACTION---` trailer off a conversational reply.
// Returns { reply, suggested_action, confidence }. A missing or malformed
// trailer means the whole thing is the reply and no action -- a
// formatting hiccup never breaks a turn.
const TRAILER = "---MILL-ACTION---";
function splitReplyTrailer(raw) {
	const s = String(raw || "");
	const i = s.lastIndexOf(TRAILER);
	if (i === -1) return { reply: s.trim(), suggested_action: null, confidence: null };
	const reply = s.slice(0, i).trim();
	let obj = {};
	try {
		obj = JSON.parse(s.slice(i + TRAILER.length).trim());
	} catch {
		return { reply: reply || s.trim(), suggested_action: null, confidence: null };
	}
	const action = ACTIONS.includes(obj.suggested_action) ? obj.suggested_action : null;
	const confidence = ["high", "medium", "low"].includes(obj.confidence) ? obj.confidence : null;
	return { reply: reply || s.trim(), suggested_action: action, confidence };
}

const PROMPT_TRAILER_INSTRUCTION = [
	"",
	"You have sibling commands that do specific jobs properly: attack, find, cross, blindspot, themes, test, proto, spinoff, audit.",
	"If the founder is asking for one of those in THIS message, do NOT do that job yourself in prose — a prose attack competing with the real /attack is exactly the confusion to avoid. Acknowledge in one short sentence ('Running the attack on this now.') and stop. The command will produce the real output.",
	"Only answer in full prose when they are thinking out loud, not requesting an action.",
	"",
	"After your reply, on its own line, output exactly:",
	TRAILER,
	'{"suggested_action": <one of "attack","find","cross","blindspot","themes","test","proto","spinoff","audit", or null>, "confidence": "high"|"medium"|"low"}',
	"Decide whether the founder is, in THIS message, asking you to run one of those actions on the current idea right now.",
	"Judge intent from THIS message only. Do not let momentum carry — a thread that just ran /attack (its prosecution is above) does not mean the next message wants another. Command outputs above are context for your reply, never a signal of intent.",
	"A message phrased as a question — 'didn't we…', 'what about…', 'is it…', 'why does…', 'did we already…' — is recall or clarification. It is NOT a request to run a command (even if it names one), unless it explicitly asks you to run it ('can you attack this?'). For a question, suggested_action is null unless that explicit ask is present.",
	'"high" = an explicit, unambiguous imperative ("attack this", "search for X", "run this past the others"). The command runs immediately; do not also answer in prose.',
	'"medium" = it reads like they probably want it but the phrasing is loose or embedded ("we should probably pressure-test this", "wonder what the others think"). A button is offered; you still reply normally.',
	'"low" / null = incidental mention ("the counterargument is obvious", "someone might attack this") or a question about the discussion. No offer.',
	"Under-suggest. When unsure between medium and low, choose low.",
	"The reply above the line must read exactly as it would without this instruction — the trailer is metadata, not part of the conversation.",
].join("\n");

module.exports = {
	ACTIONS,
	PROJECT_ONLY,
	detectRegexIntent,
	isAnaphoric,
	composeIdeaInput,
	isInterrogative,
	isExplicitRunRequest,
	shouldRouteToCommand,
	ANAPHORIC_RE,
	parseMention,
	validateSuggestion,
	splitReplyTrailer,
	PROMPT_TRAILER_INSTRUCTION,
	TRAILER,
};
