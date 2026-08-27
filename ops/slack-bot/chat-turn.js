"use strict";

// Conversational turn handling for #chats threads (build-guide-projects
// Part 14.2/14.3). Called from index.js's message router before the
// DM-capture path. Returns true if the message was consumed as a chat
// turn (caller then stops), false otherwise.

const { founderForUserId, channelId } = require("./config");
const { callFlash } = require("./llm");
const { emit } = require("./telemetry");
const { buildEvalEvent } = require("./eval-event");
const {
	getSession,
	getOrCreateStageSession,
	addTurn,
	buildContextMessages,
	maybeCompact,
} = require("./chat-session");
const { withPromoteButton } = require("./promote-button");
const { findIdeaByChannel } = require("./ideas");

const MODEL = "flash-fast";
const STAGE = "chat";

async function handleChatTurn({ message, client }) {
	if (message.bot_id) return false;
	if (!message.thread_ts) return false;

	const inChats = message.channel === channelId("chats");
	const project = inChats ? null : findIdeaByChannel(message.channel);
	if (!inChats && !project) return false;

	const speakerFounder = message.user ? founderForUserId(message.user) : null;

	// A #chats thread must already have a session (created by /chat). A
	// project stage thread gets a session lazily, keyed on that thread's
	// ts, so each stage's conversation is isolated (16.3).
	const session = inChats
		? getSession(message.thread_ts)
		: getOrCreateStageSession({
				project,
				threadTs: message.thread_ts,
				channel: message.channel,
				speakerUserId: message.user,
				speakerFounder,
			});
	if (!session) return false;

	// Uploads: only #chats offers the promote-button nudge (15.2).
	// Project channels handle file_shared for real (Part 17), so leave
	// those alone here.
	if (inChats && (message.subtype === "file_share" || (message.files && message.files.length))) {
		const text =
			"I can't store files in a chat — start a project and I'll keep it with the idea.";
		await client.chat
			.postMessage({
				channel: message.channel,
				thread_ts: session.threadTs,
				text,
				blocks: withPromoteButton(text, session.threadTs),
			})
			.catch(() => {});
		return true;
	}

	// Plain user text only past here (ignore edits, joins, other subtypes).
	if (message.subtype) return false;
	if (!message.user || !message.text) return false;

	// #chats is shared -- any allowlisted founder can contribute
	// (PROJECTS.md). Off-allowlist users are ignored, same as everywhere.
	const speaker = founderForUserId(message.user);
	if (!speaker) return true; // consumed (in a session thread) but no reply

	const text = message.text.trim();
	if (!text) return true;

	addTurn(session, { role: "user", text, userId: message.user, ts: message.ts });

	let replyText;
	let usage;
	let costUsd = 0;
	let cacheHit = false;
	const t0 = Date.now();
	try {
		const res = await callFlash(buildContextMessages(session), { model: MODEL, maxTokens: 4096 });
		replyText = res.content;
		usage = res.usage;
		costUsd = res.costUsd;
		cacheHit = res.cacheHit;
	} catch (err) {
		console.error(`chat-turn: model call failed (${session.threadTs}): ${err.message}`);
		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder: session.ownerFounder,
				status: "failed",
				reasonCode: "model_call_failed",
			}),
		);
		await client.chat
			.postMessage({
				channel: message.channel,
				thread_ts: session.threadTs,
				text: `_(couldn't generate a reply: ${err?.message || err})_`,
			})
			.catch(() => {});
		return true;
	}
	const wallClockS = (Date.now() - t0) / 1000;

	addTurn(session, { role: "assistant", text: replyText });

	await client.chat.postMessage({
		channel: message.channel,
		thread_ts: session.threadTs,
		text: replyText,
		// 15.1: promote button on chat replies only -- a project stage
		// thread is already a project.
		...(session.kind === "project" ? {} : { blocks: withPromoteButton(replyText, session.threadTs) }),
	});

	// Compaction (14.6) after the turn is recorded and answered.
	try {
		const marker = await maybeCompact(session);
		if (marker) {
			await client.chat.postMessage({
				channel: message.channel,
				thread_ts: session.threadTs,
				text: marker,
			});
		}
	} catch (err) {
		console.error(`chat-turn: compaction failed (${session.threadTs}): ${err.message}`);
	}

	emit(
		buildEvalEvent({
			stage: session.kind === "project" ? "project_turn" : STAGE,
			model: MODEL,
			founder: session.ownerFounder,
			ideaId: session.ideaId || null,
			tokensIn: usage?.prompt_tokens ?? 0,
			tokensOut: usage?.completion_tokens ?? 0,
			costUsd,
			cacheHitRatio: cacheHit ? 1 : 0,
			wallClockS,
			status: "ok",
			reasonCode: session.stage ? `stage_${session.stage}` : "turn",
		}),
	);
	return true;
}

module.exports = { handleChatTurn };
