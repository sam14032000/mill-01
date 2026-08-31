"use strict";

const { founderForUserId, channelId } = require("../config");
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");
const { createSession } = require("../chat-session");

const STAGE = "chat";

// build-guide-projects Part 14.2: `/chat <topic>` posts a thread root in
// #chats and the conversation happens in that thread. Session state is
// keyed on the root message's ts (see chat-session.js and index.js's
// message router).
async function handleChatCommand({ command, ack, client }) {
	const founder = founderForUserId(command.user_id);
	if (!founder) {
		await ack(); // D-40: off-allowlist -> silent
		return;
	}

	const topic = (command.text || "").trim();
	if (!topic) {
		await ack({
			response_type: "ephemeral",
			text: "`/chat` needs a topic: `/chat <what you want to think about>`",
		});
		return;
	}

	await ack();

	const chatsChannel = channelId("chats");
	if (!chatsChannel) {
		console.error("SLACK_CHANNEL_CHATS not configured — /chat has nowhere to open a thread");
		return;
	}

	try {
		// D-51: slash commands don't work inside threads. In this thread:
		// talk normally (I'll offer actions when you ask for one), or
		// `@Mill attack` / `@Mill find <query>` to run one immediately.
		// Same card shape as a project chat (chat-card.js) -- one chat
		// concept across both tiers. threadTs isn't known until the message
		// exists; the promote_chat handler falls back to the interaction
		// payload's message ts, so "PENDING" is fine here.
		const { chatsCardBlocks } = require("../chat-card");
		const card = chatsCardBlocks(topic, founder, "PENDING");
		const posted = await client.chat.postMessage({
			channel: chatsChannel,
			text: card.text,
			blocks: card.blocks,
		});

		createSession({
			threadTs: posted.ts,
			channel: chatsChannel,
			ownerUserId: command.user_id,
			ownerFounder: founder,
			topic,
		});

		emit(
			buildEvalEvent({
				stage: STAGE,
				model: null,
				founder,
				status: "ok",
				reasonCode: "session_started",
			}),
		);
	} catch (err) {
		console.error("chat command failed:", err);
		emit(
			buildEvalEvent({
				stage: STAGE,
				founder,
				status: "failed",
				reasonCode: "session_start_failed",
			}),
		);
	}
}

module.exports = { handleChatCommand };
