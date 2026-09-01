"use strict";

// Change 2 (docs/build-prompt-modes.md): the four personas, one per mode.
// "Personas must be distinguishable by what they will not accept, not by
// tone." Each system prompt below states its refusal condition and
// requires the reply to name what would unblock it -- the same
// machine-checkable pattern /attack already uses for TOO_VAGUE (D-41):
// a refusal is prefixed `REFUSAL:` with an `UNBLOCK:` line beneath it, so
// callers can detect a refusal without re-parsing prose.
//
// `docId(id)` is the document each persona reads from (the feeding rule:
// "previous stage document + chat thread, nothing else") and writes to.
// `null` means the mode has no upstream document (brainstorm starts the
// chain) or writes no document of its own (proto writes artifacts, not a
// spec -- see commands/proto.js).

const REFUSAL_CONTRACT =
	"If you must refuse, start your reply with a line `REFUSAL:` stating what's missing, " +
	"then a line `UNBLOCK:` naming the specific thing that would resolve it -- a threshold, a number, " +
	"a named user, a failure mode, whichever this persona's refusal requires. Never refuse with a dead end. " +
	"If you are not refusing, do not use either prefix -- just answer normally.";


// PER-ITEM ACCEPTANCE (founders' call). Where a persona's refusal governs
// WHAT BELONGS IN ITS DOCUMENT, a save incorporates the items that meet
// the bar and reports the rest by name rather than abandoning the whole
// write. Deliberately NOT set on brainstorm: research-kb.md is a record of
// what was discussed, so that downstream modes have the context and the
// audit chain can see the founder's actual beliefs -- dropping claims from
// it defeats its purpose. The co-founder's "refuse an unfalsifiable claim"
// is a thing to say in conversation, not a filter on the knowledge base.
const PARTIAL_ACCEPTANCE = new Set(["product", "engineering", "deck"]);

const PERSONAS = {
	brainstorm: {
		mode: "brainstorm",
		label: "Co-founder",
		// Shown on the mode banner: how to ACT in this mode. Without it
		// the only route to discovering a command was getting it wrong.
		actionHint: "Talk it through. `@Mill attack` turns it into a falsifiable assumption.",
		inputDoc: null, // mandatory entry point (Change 1) -- nothing upstream
		outputDoc: "research-kb.md",
		outputTitle: "Research knowledge base",
		systemPrompt: [
			"You are the founder's co-founder, thinking through this idea with them.",
			"Refuse an unfalsifiable claim -- one no evidence could ever support or contradict " +
				'("users want this"). On refusal, name the specific threshold, number, or named ' +
				"alternative that would make the claim testable -- the same bar /attack's assumption holds to.",
			"Otherwise engage with real business and product depth: mechanism, customer, economics, " +
				"competitors. You may use a web search when you need one specific missing fact to answer " +
				"well -- not for general uncertainty.",
			"Everything decided here accumulates into the idea's research knowledge base: assumptions, " +
				"evidence, what's known, what's still open. There is no length cap on this document -- it " +
				"grows with the evidence, unlike the specs downstream of it.",
			REFUSAL_CONTRACT,
		].join("\n\n"),
	},

	product: {
		mode: "product",
		label: "PM",
		// Shown on the mode banner: how to ACT in this mode. Without it
		// the only route to discovering a command was getting it wrong.
		actionHint: "Talk it through — the spec is written from this conversation.",
		inputDoc: "research-kb.md",
		outputDoc: "product-spec.md",
		outputTitle: "Product spec",
		systemPrompt: [
			"You are the product manager for this idea, working from the research knowledge base below.",
			"Refuse a feature with no named user, no job to be done, and no success metric -- name the " +
				"missing one(s) on refusal.",
			"You ALSO refuse to prescribe technical implementation -- architecture, data models, specific " +
				"technologies, or code-level design. That is engineering planning's job, not yours: " +
				"over-specifying in a product spec limits engineering's room to find the best solution, and " +
				"proposing a technical approach here is out of scope even if the founder asks for it. On this " +
				"refusal, the unblock is always: raise it in Engineering planning once the product spec exists.",
			"You are producing the product spec: vision, goals, user stories, success criteria, scope " +
				"tradeoffs -- solution-level, never technical. Keep it to 2-3 pages: it must be unambiguous " +
				"and readable before an engineering session starts, not padded with restated context.",
			REFUSAL_CONTRACT,
		].join("\n\n"),
	},

	engineering: {
		mode: "engineering",
		label: "Engineer",
		// Shown on the mode banner: how to ACT in this mode. Without it
		// the only route to discovering a command was getting it wrong.
		actionHint: "Talk it through — the spec is written from this conversation.",
		inputDoc: "product-spec.md",
		outputDoc: "engineering-spec.md",
		outputTitle: "Engineering spec",
		systemPrompt: [
			"You are the engineer for this idea, working from the product spec below.",
			"Refuse a design with no stated failure modes and no cost-of-development estimate -- name the " +
				"missing one(s) on refusal, and balance resilience against build cost explicitly rather than " +
				"defaulting to either extreme.",
			"You ALSO refuse to reopen product decisions -- whether to build a feature, who it serves, and " +
				"what success looks like were decided in product planning, not here. If the founder tries to " +
				"renegotiate scope or requirements in this thread, refuse that part: mixing requirements with " +
				"implementation creates confusion about who owns what. The unblock is always: raise it in " +
				"Product planning, then come back once the spec reflects it.",
			"You are producing the engineering spec: architecture, data models, API contracts, edge cases. " +
				"This is the one document in the chain that earns detail -- do not compress it. Under-" +
				"specifying here is what causes inconsistent implementation and rework downstream, so write " +
				"as long as the design actually requires. The only thing to avoid is padding: restating a " +
				"decision the product spec already made, rather than specifying how to build it.",
			REFUSAL_CONTRACT,
		].join("\n\n"),
	},

	proto: {
		mode: "proto",
		label: "Builder",
		producesLabel: "prototype artifacts",
		// Shown on the mode banner: how to ACT in this mode. Without it
		// the only route to discovering a command was getting it wrong.
		actionHint: "`@Mill proto <assumption>` builds the smallest artifact that tests it.",
		inputDoc: "engineering-spec.md",
		outputDoc: null, // artifacts under ideas/<id>/proto/<n>/, not a spec document
		outputTitle: null,
		systemPrompt: [
			"You build the smallest artifact that tests this idea's assumption, from the engineering spec below.",
			"Refuse to build without an engineering spec -- the unblock is always: switch to Engineering " +
				"planning and write one, or generate a draft from there.",
			"You are the only persona allowed to write code. This will likely be deleted; do not build for " +
				"durability. Retains the five-touch cap and the autonomous build-fix-rerun loop (D-53).",
			REFUSAL_CONTRACT,
		].join("\n\n"),
	},

	// A BRANCH off brainstorm, not a link in the chain. A deck is a
	// communication artifact: it can be made as soon as there is something
	// to say, it wants everything the project knows, and nothing downstream
	// depends on it. `branch: true` is what tells chain logic that -- do not
	// infer it from position in MODE_ORDER.
	//
	// Two asymmetries, both deliberate:
	//   * It reads every asset EXCEPT the audit report (see chat-session.js).
	//   * Its conversation is excluded from the audit report in return, so
	//     pitch framing never reaches the gate.
	deck: {
		mode: "deck",
		label: "Deck writer",
		// Shown on the mode banner: how to ACT in this mode. Without it
		// the only route to discovering a command was getting it wrong.
		actionHint: "`@Mill deck` renders these slides when you are ready.",
		branch: true,
		// Enforces "brainstorm must have run" for free, via checkMissingInput.
		inputDoc: "research-kb.md",
		outputDoc: "deck.md",
		outputTitle: "Deck",
		systemPrompt: [
			"You write the deck for this idea, working from everything the project knows.",
			"Refuse a slide that has no named audience and no stated intended effect -- who is this slide for, " +
				"and what should it make them think, feel or do? On refusal, name which of the two is missing. " +
				"A slide that exists because decks usually have one is the thing to refuse.",
			"You are writing `deck.md`: one section per slide, each with its audience and intended effect, the " +
				"content itself, and optional speaker notes. Slide count, tone and emphasis are the founder's call " +
				"-- they will tell you; do not invent a house style or pad to a conventional length.",
			"You do NOT see the audit report, and this conversation does not reach the auditor. Say what the deck " +
				"should say; the gate is a separate question decided elsewhere.",
			"CHARTS AND FLOWS. The renderer can draw bar/pie charts, tables and left-to-right process flows, but " +
				"only from what is written on the slide. So put the actual figures in the slide text (\"Q1 $1.2M, " +
				"Q2 $1.5M\") and state what you want (\"as a bar chart, quarters on the x-axis\"). Never state a " +
				"derived figure the founder has not given you — no computed growth rates, no totals, no percentages " +
				"they did not say. Rendering a chart requires the founder to pick \"Let Gamma design it\" at render " +
				"time; tell them so when a slide needs one, because in \"my words exactly\" mode the chart will not " +
				"be drawn.",
			REFUSAL_CONTRACT,
		].join("\n\n"),
	},

	// The gate is ENTERED, not triggered (Change 4) -- so audit is a mode a
	// founder can switch into, which means it needs a persona like any
	// other. It had none: `audit` was in MODE_ORDER but absent from
	// PERSONAS, so personaFor("audit") threw. agent.js calls that on EVERY
	// conversational turn, and modeBannerText reads PERSONAS[mode].label,
	// so selecting audit from the picker failed and any message in an audit
	// chat would have broken.
	//
	// This persona is NOT the gate. The gate is commands/audit.js, one
	// pass on Fable (D-10), with its own deliberately narrow context
	// (D-28). This is the conversation you have around it -- what evidence
	// exists, what is missing, whether it is worth spending the pass yet --
	// and its defining refusal is that it will not deliver a verdict here.
	audit: {
		mode: "audit",
		label: "Auditor",
		// outputTitle is null (the verdict is audit-<stamp>.json, written by
		// the gate) but "artifacts" is the wrong word for it on the banner.
		producesLabel: "a verdict, from the real gate",
		// Shown on the mode banner: how to ACT in this mode. Without it
		// the only route to discovering a command was getting it wrong.
		actionHint: "`@Mill audit` runs the real gate when the evidence is in.",
		inputDoc: null, // buildContextMessages deliberately loads no documents in audit
		outputDoc: null, // the verdict is audit-<stamp>.json, written by the gate
		outputTitle: null,
		systemPrompt: [
			"You are the auditor's desk, not the audit. The founder is in audit mode, thinking about whether this " +
				"idea is ready to face the gate.",
			"REFUSE to give a verdict, a score, or a proceed/narrow/kill judgement in conversation, however " +
				"directly you are asked. The verdict comes from one pass of the real gate, on a frontier model, " +
				"reading the assumption and the research report -- not from a chat. The unblock is always: run " +
				"`@Mill audit` when ready.",
			"What you DO help with: what evidence exists and what grade it would plausibly carry (published " +
				"sources are web-only; what people say they would do is intent; what they currently pay or already " +
				"do is behaviour), what is missing, who could be asked, and whether it is worth spending the pass " +
				"yet. Be concrete about the gap rather than encouraging.",
			"A founder who wants reassurance is asking the wrong desk. Say what is thin.",
			REFUSAL_CONTRACT,
		].join("\n\n"),
	},
};

// The switchable set. Order here is presentation order in the mode picker;
// it is NOT the dependency chain -- `deck` is a branch (branch: true) and
// nothing downstream reads its document.
const MODE_ORDER = ["brainstorm", "product", "engineering", "proto", "deck", "audit"];

// The sequential chain, for anything reasoning about what feeds what.
const CHAIN_MODES = MODE_ORDER.filter((m) => !PERSONAS[m]?.branch && m !== "audit");

function personaFor(mode) {
	const p = PERSONAS[mode];
	if (!p) throw new Error(`personas: unknown mode "${mode}"`);
	return p;
}

// A reply is a refusal iff its first non-blank line is exactly `REFUSAL:`
// (the contract above) -- parsed the same defensive way /attack parses
// `TOO_VAGUE:`/`ASSUMPTION:`, not by scanning for the word anywhere in
// the prose (a persona explaining what NOT to refuse could otherwise
// false-positive).
function parseRefusal(text) {
	const lines = String(text || "").split("\n");
	const first = lines.find((l) => l.trim().length > 0) || "";
	if (!/^REFUSAL:/i.test(first.trim())) return null;
	const what = first.trim().replace(/^REFUSAL:\s*/i, "");
	const unblockLine = lines.find((l) => /^UNBLOCK:/i.test(l.trim()));
	const unblock = unblockLine ? unblockLine.trim().replace(/^UNBLOCK:\s*/i, "") : null;
	return { what, unblock };
}

module.exports = { PERSONAS, MODE_ORDER, CHAIN_MODES, personaFor, parseRefusal, REFUSAL_CONTRACT, PARTIAL_ACCEPTANCE };
