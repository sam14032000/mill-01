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
	addTurn,
	buildContextMessages,
	maybeCompact,
} = require("./chat-session");

const MODEL = "flash-fast";
const STAGE = "chat";

async function handleChatTurn({ message, client }) {
	// Must be a plain user message in a #chats thread that has a session.
	if (message.bot_id) return false;
	if (message.subtype) return false;
	if (!message.user || !message.text) return false;
	if (message.channel !== channelId("chats")) return false;
	if (!message.thread_ts) return false;

	const session = getSession(message.thread_ts);
	if (!session) return false;

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
			stage: STAGE,
			model: MODEL,
			founder: session.ownerFounder,
			tokensIn: usage?.prompt_tokens ?? 0,
			tokensOut: usage?.completion_tokens ?? 0,
			costUsd,
			cacheHitRatio: cacheHit ? 1 : 0,
			wallClockS,
			status: "ok",
			reasonCode: "turn",
		}),
	);
	return true;
}

module.exports = { handleChatTurn };
