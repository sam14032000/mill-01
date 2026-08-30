"use strict";

// The command set exposed to the agent loop (agent.js) as tools. Each
// tool is a thin adapter over the existing command handler, invoked
// through command-shim.js's dispatchCommand -- nothing here
// re-implements a handler or its gates. The handler owns its own
// enforcement (research_stub, C-07, the touch cap, the named-assumption
// requirement, TOO_VAGUE); this layer just runs a fast state
// precondition first so the agent gets "can't do that yet, because X"
// instead of a bare refusal it can't reason about.
//
// A tool returns a short string the model reads on the next turn. The
// handler posts the real output into the thread itself (landing in the
// progress placeholder, Bug 1).

const { dispatchCommand } = require("./command-shim");
const { validateSuggestion, REASON_MESSAGE, PROJECT_ONLY } = require("./intent");
const { inlineFactSearch } = require("./search");

// OpenAI tool schema per command. Descriptions are what the model
// routes on -- kept close to docs/COMMANDS.md's one-liners.
const SCHEMAS = [
	{
		name: "attack",
		description:
			"Make the strongest case against the current idea (the prosecution) and produce a single falsifiable assumption with a number and a named alternative. Use when the founder asks to attack / steelman the case against / poke holes in / pressure-test the idea. Refuses if the idea is still too vague to attack.",
		parameters: { type: "object", properties: { focus: { type: "string", description: "optional: an angle to focus the attack on" } } },
	},
	{
		name: "think",
		description:
			"Develop the idea concretely (mechanism, who it serves, what has to be true), then attack it from this founder's blind spot. Use when the founder asks you to develop / flesh out / think through the idea.",
		parameters: { type: "object", properties: { focus: { type: "string" } } },
	},
	{
		name: "cross",
		description:
			"Read the idea through the other two founders' failure profiles and return their two distinct angles. Use when the founder asks what the other founders would say / think, or to run it past the others.",
		parameters: { type: "object", properties: {} },
	},
	{
		name: "blindspot",
		description:
			"Attack the idea from the shared blind spot of all three founders. Use when the founder asks what they are all missing / where the shared blind spot is.",
		parameters: { type: "object", properties: {} },
	},
	{
		name: "themes",
		description: "Surface this founder's recurring preoccupations from their recent captures. Use when they ask about their themes / what they keep circling back to.",
		parameters: { type: "object", properties: {} },
	},
	{
		name: "find",
		description:
			"Surface web search. NOT evidence. Two modes: mode:\"quick\" — mid-answer, when YOU need one concrete missing fact (a price, a rule/threshold, a market number, a date, whether a named company exists); 1-2 queries, you fold the result into your prose reply. mode:\"broad\" — only when the FOUNDER explicitly asks you to look something up / dig in / research a question; more queries, posted as a separate block. Do not use quick mode just because you feel unsure or the founder is being abstract.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "the concrete thing to search for, with 'this'/'these' resolved yourself" },
				mode: { type: "string", enum: ["quick", "broad"], description: "quick = your own inline fact check; broad = the founder asked" },
			},
			required: ["query"],
		},
	},
	{
		name: "test",
		description:
			"Run a research pass on the idea's named assumption (asks the founder for field evidence first, then writes a report). Project only. Use when the founder asks to research / test the assumption.",
		parameters: { type: "object", properties: {} },
	},
	{
		name: "audit",
		description:
			"The gate: rule proceed / narrow / kill on the researched assumption (Fable 5, one pass). Project only, needs a completed research pass. Use when the founder asks to audit / send to the gate / get a verdict.",
		parameters: { type: "object", properties: {} },
	},
	{
		name: "proto",
		description:
			"Build the smallest artifact that tests one named assumption (landing page, mock, or a working script it builds and runs in the sandbox). Project only, five-touch cap. Use when the founder asks to prototype / mock up / build something to test the assumption.",
		parameters: { type: "object", properties: { assumption: { type: "string", description: "the specific assumption this prototype tests (required)" } }, required: ["assumption"] },
	},
	{
		name: "spinoff",
		description:
			"Create a child project from a new idea that branched off this one. Project only. Use when the founder wants to split a tangent into its own project.",
		parameters: { type: "object", properties: { idea: { type: "string", description: "the new idea to spin off (required)" } }, required: ["idea"] },
	},
];

function toolSpecs() {
	return SCHEMAS.map((s) => ({ type: "function", function: s }));
}
const TOOL_NAMES = new Set(SCHEMAS.map((s) => s.name));

// The free-text argument each command's handler expects in `command.text`.
function argText(name, args) {
	switch (name) {
		case "find":
			return String(args.query || "").trim();
		case "proto":
			return String(args.assumption || "").trim();
		case "spinoff":
			return String(args.idea || "").trim();
		case "attack":
		case "think":
			return String(args.focus || "").trim();
		default:
			return "";
	}
}

// Run one tool call. `ctx` carries the invocation context the shim needs
// plus the precondition inputs. Returns { posted, result }:
//   posted=true  -- the handler ran and put its output in the thread;
//                   the agent stops here (the command owns the response).
//   posted=false -- blocked by a precondition or errored; NOTHING is in
//                   the thread, so the agent must loop once and let the
//                   model relay `result` to the founder.
async function runTool(name, args, ctx) {
	if (!TOOL_NAMES.has(name)) return { posted: false, result: `no such tool: ${name}` };

	// Fast precondition (the handler still enforces for real).
	const v = validateSuggestion(name, {
		inChats: ctx.inChats,
		project: ctx.project,
		assumption: ctx.assumption,
		research: ctx.research,
	});
	if (!v.ok) {
		return { posted: false, result: `did not run \`${name}\`: ${REASON_MESSAGE[v.reason] || v.reason}. Tell the founder this plainly, in one sentence.` };
	}
	if (name === "proto" && !argText("proto", args)) {
		return { posted: false, result: "did not run `proto`: it needs a specific named assumption. Ask the founder which assumption to test." };
	}
	if (name === "spinoff" && !argText("spinoff", args)) {
		return { posted: false, result: "did not run `spinoff`: it needs the new idea. Ask the founder what to spin off." };
	}

	// D-53 Mode 1: agent-initiated inline fact check. Does NOT post a
	// block -- the findings come back as the tool result and the agent
	// folds them into its prose reply (agent.js adds the not-evidence
	// marker).
	if (name === "find" && args.mode === "quick") {
		const { findings, queryCount } = await inlineFactSearch(argText("find", args));
		return {
			posted: false,
			search: "agent",
			result:
				`INLINE WEB CHECK (${queryCount} quer${queryCount === 1 ? "y" : "ies"}) — surface search, NOT evidence. ` +
				`Use this to answer, then end your reply with: _(quick web check — not verified, not evidence)_\n\n${findings}`,
		};
	}

	let disp;
	try {
		disp = await dispatchCommand({
			action: name,
			text: argText(name, args),
			channelId: ctx.channelId,
			userId: ctx.userId,
			threadTs: ctx.threadTs,
			client: ctx.client,
			progressTs: ctx.progressTs,
			progressChannel: ctx.progressChannel,
			// D-53 Mode 2: the founder pushed for this -> broad breadth.
			...(name === "find" ? { broad: true } : {}),
		});
	} catch (err) {
		return { posted: false, result: `\`${name}\` errored: ${err?.message || err}. Tell the founder it failed.` };
	}

	// The handler ran but never wrote to the placeholder -- its own catch
	// swallowed a Slack error (msg_too_long, etc). Don't report success;
	// let the agent tell the founder and stop the "Thinking…" hang.
	if (ctx.progressTs && disp && disp.progressConsumed === false) {
		return {
			posted: false,
			result: `\`${name}\` ran but couldn't post its output (it was likely too long). Tell the founder briefly and suggest a narrower query.`,
		};
	}

	return { posted: true, search: name === "find" ? "founder" : undefined, result: `\`${name}\` ran; its output is in the thread.` };
}

module.exports = { toolSpecs, runTool, TOOL_NAMES, PROJECT_ONLY };
