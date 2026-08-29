"use strict";

// Runs a command that was requested via `@Mill <cmd>` in a thread or via
// a tapped intent offer -- i.e. not through Slack's slash-command
// mechanism (which doesn't work in threads, D-51).
//
// It builds the exact { command, ack, client } shape the real handlers
// take and calls them unchanged. Nothing here re-implements or bypasses a
// handler's gates: /audit's research_stub refusal, C-07's evidence
// downgrade, /proto's named-assumption requirement and five-touch cap all
// live inside the handlers and fire identically regardless of how the
// handler was reached.

const { handleAttackCommand } = require("./commands/attack");
const { handleThinkCommand } = require("./commands/think");
const { handleCrossCommand } = require("./commands/cross");
const { handleBlindspotCommand } = require("./commands/blindspot");
const { handleThemesCommand } = require("./commands/themes");
const { handleFindCommand } = require("./commands/find");
const { handleTestCommand } = require("./commands/test");
const { handleAuditCommand } = require("./commands/audit");
const { handleProtoCommand } = require("./commands/proto");
const { handleSpinoffCommand } = require("./commands/spinoff");
const { getSession, readOriginContext } = require("./chat-session");
const { findIdeaByChannel } = require("./ideas");
const { withProgress, postResult } = require("./reply");

// How many recent turns of the thread to hand a command as context.
const CONTEXT_TURNS = Number(process.env.MILL_CMD_CONTEXT_TURNS) || 14;

const HANDLERS = {
	attack: handleAttackCommand,
	think: handleThinkCommand,
	cross: handleCrossCommand,
	blindspot: handleBlindspotCommand,
	themes: handleThemesCommand,
	find: handleFindCommand,
	test: handleTestCommand,
	audit: handleAuditCommand,
	proto: handleProtoCommand,
	spinoff: handleSpinoffCommand,
};

// When a mention/offer carries no free-text argument, the command still
// needs a subject. Two shapes:
//
//   SUBJECT_FROM_THREAD -- brainstorm commands take "an idea". In a
//     thread the idea is the conversation, not the imperative sentence
//     that triggered the offer ("attack this"). Rebuild it from the
//     topic plus the substantive user turns, dropping bare imperatives.
//
//   QUERY_FROM_LAST_TURN -- /find takes a query; the founder's own
//     phrasing ("search for what iD Fresh charges") is the query.
//
// /proto is deliberately in neither: it must refuse without an explicit
// named assumption (D-29), so it gets no fallback at all.
const SUBJECT_FROM_THREAD = new Set(["attack", "think", "cross", "blindspot", "spinoff"]);
const QUERY_FROM_LAST_TURN = new Set(["find"]);

// A turn that only tells the bot to act ("attack this idea", "ok now
// steelman the case against it") -- an offer trigger, not the idea. Two
// conditions together: it leads with an imperative verb, and it's short
// enough to carry no idea of its own.
const IMPERATIVE_LEAD = /^(?:ok(?:ay)?[,\s]+|so[,\s]+|now[,\s]+|please[,\s]+|can you\s+|could you\s+|let'?s\s+|go ahead and\s+)*(?:attack|steel[- ]?man|poke holes in|argue against|research|test|prototype|mock this up|spin (?:this )?(?:off|out)|audit|cross|run (?:this|it|that) (?:past|by)|what would the others)\b/i;
function isBareImperative(t) {
	const s = String(t || "").trim();
	return IMPERATIVE_LEAD.test(s) && s.split(/\s+/).length <= 14;
}

function lastUserTurn(threadTs) {
	const s = threadTs ? getSession(threadTs) : null;
	if (!s || !Array.isArray(s.turns)) return "";
	for (let i = s.turns.length - 1; i >= 0; i--) {
		if (s.turns[i].role === "user" && s.turns[i].text?.trim()) return s.turns[i].text.trim();
	}
	return "";
}

// Topic + the last few substantive user turns, so a conversationally
// invoked /attack etc. sees the idea rather than the word "attack".
function threadSubject(threadTs) {
	const s = threadTs ? getSession(threadTs) : null;
	if (!s || !Array.isArray(s.turns)) return "";
	const userTurns = s.turns
		.filter((t) => t.role === "user" && t.text?.trim())
		.map((t) => t.text.trim())
		.filter((t) => !isBareImperative(t));
	const recent = userTurns.slice(-4);
	const parts = [];
	if (s.topic) parts.push(s.topic);
	if (recent.length) parts.push(recent.join("\n"));
	return parts.join("\n\n").trim() || lastUserTurn(threadTs);
}

// The running conversation a command is being invoked from -- recent
// turns, plus the project origin. Every brainstorm/research command reads
// this (ROOT CAUSE B): /find and /test resolve referring expressions
// against it, and /attack /think /cross /blindspot treat it as the idea
// itself when the invoking message is just a pointer ("attack this").
// Falls back to the project's origin + idea.md even with no live session
// for the thread (e.g. `@Mill attack` as the first message in a stage
// thread).
function threadContextText(threadTs, channelId) {
	const s = threadTs ? getSession(threadTs) : null;
	const lines = [];

	let ideaId = s && s.kind === "project" ? s.ideaId : null;
	if (!ideaId && channelId) {
		const proj = findIdeaByChannel(channelId);
		if (proj) ideaId = proj.id;
	}
	if (ideaId) {
		const origin = readOriginContext(ideaId);
		if (origin) lines.push(origin, "---");
	} else if (s && s.topic) {
		lines.push(`Chat topic: ${s.topic}`, "");
	}

	if (s && Array.isArray(s.turns)) {
		for (const t of s.turns.slice(-CONTEXT_TURNS)) {
			if (!t.text?.trim()) continue;
			lines.push(`${t.role === "user" ? "Founder" : "Mill"}: ${t.text.trim()}`);
		}
	}
	return lines.join("\n").trim();
}

async function dispatchCommand({ action, text, channelId, userId, threadTs, client, progressTs = null, progressChannel = null, broad = undefined }) {
	const handler = HANDLERS[action];
	if (!handler) return { ok: false, reason: "unknown_action" };
	let effectiveText = (text || "").trim();
	// A tapped offer passes the turn that triggered it, which is usually a
	// bare imperative ("attack this") carrying no idea. For the brainstorm
	// commands that's not a usable subject -- rebuild from the thread.
	if (effectiveText && SUBJECT_FROM_THREAD.has(action) && isBareImperative(effectiveText)) {
		effectiveText = "";
	}
	if (!effectiveText && SUBJECT_FROM_THREAD.has(action)) effectiveText = threadSubject(threadTs);
	else if (!effectiveText && QUERY_FROM_LAST_TURN.has(action)) effectiveText = lastUserTurn(threadTs);
	const command = {
		command: `/${action}`,
		channel_id: channelId,
		user_id: userId,
		text: effectiveText,
		thread_ts: threadTs || undefined,
		via: "shim", // invocation-path marker; handlers ignore it
		// The conversation this command was invoked from (ROOT CAUSE B).
		// /find and /test resolve referring expressions against it;
		// /attack /think /cross /blindspot treat it as the idea itself
		// when the invoking text is just a pointer. /audit deliberately
		// never reads it (D-28: the auditor sees no brainstorm transcript).
		thread_context: threadContextText(threadTs, channelId),
		// Bug 1: the "On it — running /x…" placeholder to land the result in.
		progress: progressTs ? { ts: progressTs, channel: progressChannel || channelId } : null,
		// D-53 Mode 2: /find broad breadth when the founder pushed for it.
		...(broad !== undefined ? { broad } : {}),
	};

	// The result lands in the placeholder instead of a second message.
	const cmdClient = withProgress(client, { progressTs, progressChannel: progressChannel || channelId });

	// Handlers deliver input-validation refusals ("needs a named
	// assumption", "can't find idea", "state is killed") via
	// ack({response_type:"ephemeral", text}) -- which shows for a real
	// slash command but would vanish on this path. Capture it and post it
	// to the thread instead, so a refusal reaches the founder identically
	// regardless of invocation path.
	let ackText = null;
	const ack = async (payload) => {
		if (payload && typeof payload.text === "string") ackText = payload.text;
	};

	await handler({ command, ack, client: cmdClient });

	if (ackText) {
		await postResult(cmdClient, {
			channel: channelId,
			...(threadTs ? { thread_ts: threadTs } : {}),
			text: ackText,
		}).catch(() => {});
	}
	return { ok: true };
}

module.exports = { dispatchCommand, HANDLERS };
