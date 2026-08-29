"use strict";

// The one agent loop above the commands (replaces the regex + confidence
// + guard cascade that used to live in chat-turn.js -- D-51/D-52).
//
// A founder says something in a #chats thread or a project stage thread.
// This gets the tool set + the thread context and decides: run one
// command, or just reply. Gates stay inside the commands (research_stub,
// C-07, the touch cap, the named-assumption requirement, TOO_VAGUE),
// enforced regardless of caller -- the loop never re-implements one.
//
// Boundary: everything goes through `runTurn({ session, message,
// client })`, which reads and writes session state in the project's own
// JSON schema (chat-session.js's disk mirror). That is what makes the
// loop implementation swappable -- a maintained harness could take this
// function's place without touching the tools or the session format.
//
// Deliberate invocations (`@Mill <cmd>`, slash commands, buttons) do NOT
// come through here -- they go straight to command-shim's dispatchCommand.

const { callFlashTools } = require("./llm");
const { emit } = require("./telemetry");
const { buildEvalEvent } = require("./eval-event");
const { addTurn, buildContextMessages, maybeCompact } = require("./chat-session");
const { withPromoteButton } = require("./promote-button");
const { readState, readAssumption, readLatestResearch } = require("./ideas");
const { toolSpecs, runTool } = require("./tools");

const MODEL = "flash-fast";
const MAX_STEPS = Number(process.env.MILL_AGENT_MAX_STEPS) || 3;

const SYSTEM_PROMPT = [
	"You are Mill, a founder's thinking partner inside a Slack thread. You have tools that do specific jobs properly (attack, think, cross, blindspot, themes, find, test, audit, proto, spinoff).",
	"",
	"Your default is to REPLY IN PROSE. Only call a tool when the founder's LATEST message is itself an explicit instruction to run that job — an imperative: \"attack this\", \"look up X\", \"what would the others say\", \"prototype it\", \"run the research pass\".",
	"Do NOT call a tool when the latest message is:",
	"- a statement or a musing (\"i keep coming back to whether the liability is ours\", \"the margins worry me\")",
	"- any kind of question (\"didn't we…\", \"what about…\", \"is that defensible?\", \"why does the incumbent tolerate this?\") — a question is recall or clarification, NOT a request, unless it explicitly asks you to run something (\"can you attack this?\")",
	"even if the idea looks attackable or researchable. When unsure, reply in prose.",
	"",
	"Prior tool output in the thread is context for your reply, never a signal to run that tool again.",
	"Call at most one tool. The founder drives the next step; do not chain commands.",
	"When you call a tool, produce no prose — the tool posts the real output.",
	"Prose replies: short and concrete. Engage with what they said, push on the weak point, ask for the number or the named alternative when a claim is vague. No headings, no essays.",
].join("\n");

function parseArgs(tc) {
	try {
		const a = JSON.parse(tc.function?.arguments || "{}");
		return a && typeof a === "object" ? a : {};
	} catch {
		return {};
	}
}

async function runTurn({ session, message, client }) {
	const isProject = session.kind === "project";
	const ideaId = session.ideaId || null;
	const stageName = isProject ? "project_turn" : "chat";

	const ctx = {
		founder: session.ownerFounder,
		channelId: message.channel,
		userId: message.user,
		threadTs: session.threadTs,
		client,
		inChats: !isProject,
		project: isProject && ideaId ? readState(ideaId) : null,
		assumption: isProject && ideaId ? readAssumption(ideaId) : null,
		research: isProject && ideaId ? readLatestResearch(ideaId) : null,
	};

	const placeholderTs = await client.chat
		.postMessage({ channel: message.channel, thread_ts: session.threadTs, text: "_Thinking…_" })
		.then((r) => r.ts)
		.catch(() => null);

	const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...buildContextMessages(session)];

	let costUsd = 0;
	let tokensIn = 0;
	let tokensOut = 0;
	let cacheHits = 0;
	let calls = 0;
	const toolsCalled = [];
	let toolsIgnored = 0;
	const t0 = Date.now();

	for (let step = 0; step < MAX_STEPS; step++) {
		let res;
		try {
			res = await callFlashTools(messages, { model: MODEL, maxTokens: 2048, tools: toolSpecs() });
		} catch (err) {
			console.error(`agent: model call failed (${session.threadTs}): ${err.message}`);
			emit(buildEvalEvent({ stage: stageName, model: MODEL, founder: session.ownerFounder, ideaId, status: "failed", reasonCode: "model_call_failed", toolsCalled: [], iterations: step + 1, repliedWithoutTool: false }));
			const m = `_(couldn't generate a reply: ${err?.message || err})_`;
			if (placeholderTs) await client.chat.update({ channel: message.channel, ts: placeholderTs, text: m }).catch(() => {});
			else await client.chat.postMessage({ channel: message.channel, thread_ts: session.threadTs, text: m }).catch(() => {});
			return true;
		}
		calls += 1;
		costUsd += res.costUsd || 0;
		tokensIn += res.usage?.prompt_tokens ?? 0;
		tokensOut += res.usage?.completion_tokens ?? 0;
		if (res.cacheHit) cacheHits += 1;

		// ---- tool call: run the first, ignore the rest (founder-paced) ----
		if (res.toolCalls.length) {
			const tc = res.toolCalls[0];
			toolsIgnored += res.toolCalls.length - 1;
			const name = tc.function?.name;
			const args = parseArgs(tc);
			toolsCalled.push(name);

			const before = session.turns.length;
			const out = await runTool(name, args, { ...ctx, progressTs: placeholderTs, progressChannel: message.channel });

			// Keep the thread transcript continuous even when the handler
			// (project-stage branch) didn't record its own turn -- else the
			// next turn's context shows two user messages back to back and
			// the model re-reads stale intent.
			if (session.turns.length === before) {
				addTurn(session, { role: "assistant", text: `[ran \`${name}\` — output is in the thread]`, kind: "command" });
			}

			if (out.posted) {
				// The command put its output in the thread and owns the
				// response. Stop -- no framing round-trip (D-52 Root Cause A).
				emit(
					buildEvalEvent({
						stage: stageName, model: MODEL, founder: session.ownerFounder, ideaId,
						tokensIn, tokensOut, costUsd, cacheHitRatio: calls ? cacheHits / calls : 0,
						wallClockS: (Date.now() - t0) / 1000, status: "ok", reasonCode: `tool_${name}`,
						toolsCalled, toolsIgnored, iterations: step + 1, repliedWithoutTool: false,
					}),
				);
				return true;
			}

			// Blocked by a precondition or errored -- nothing is in the
			// thread. Loop once so the model relays it to the founder.
			messages.push({ role: "assistant", content: null, tool_calls: [tc] });
			messages.push({ role: "tool", tool_call_id: tc.id, content: out.result });
			continue;
		}

		// ---- plain reply ----
		const replyText = (res.content || "").trim();
		if (!replyText) {
			// no content, no tool -- give it one more step, then bail
			messages.push({ role: "user", content: "(You returned nothing. Reply in prose, or call a tool.)" });
			continue;
		}

		addTurn(session, { role: "assistant", text: replyText });
		const blocks = withPromoteButton(replyText, session.threadTs);
		if (placeholderTs) await client.chat.update({ channel: message.channel, ts: placeholderTs, text: replyText, blocks }).catch(() => {});
		else await client.chat.postMessage({ channel: message.channel, thread_ts: session.threadTs, text: replyText, blocks }).catch(() => {});

		try {
			const marker = await maybeCompact(session);
			if (marker) await client.chat.postMessage({ channel: message.channel, thread_ts: session.threadTs, text: marker }).catch(() => {});
		} catch (err) {
			console.error(`agent: compaction failed (${session.threadTs}): ${err.message}`);
		}

		emit(
			buildEvalEvent({
				stage: stageName,
				model: MODEL,
				founder: session.ownerFounder,
				ideaId,
				tokensIn,
				tokensOut,
				costUsd,
				cacheHitRatio: calls ? cacheHits / calls : 0,
				wallClockS: (Date.now() - t0) / 1000,
				status: "ok",
				reasonCode: session.stage ? `stage_${session.stage}` : "turn",
				toolsCalled,
				toolsIgnored,
				iterations: step + 1,
				repliedWithoutTool: true,
			}),
		);
		return true;
	}

	// Ran out of steps without a plain reply or a tool call.
	const m = "_(couldn't settle on a response — try rephrasing)_";
	if (placeholderTs) await client.chat.update({ channel: message.channel, ts: placeholderTs, text: m }).catch(() => {});
	emit(buildEvalEvent({ stage: stageName, model: MODEL, founder: session.ownerFounder, ideaId, tokensIn, tokensOut, costUsd, cacheHitRatio: calls ? cacheHits / calls : 0, wallClockS: (Date.now() - t0) / 1000, status: "failed", reasonCode: "max_steps", toolsCalled, iterations: MAX_STEPS, repliedWithoutTool: false }));
	return true;
}

module.exports = { runTurn, SYSTEM_PROMPT };
