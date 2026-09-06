"use strict";

// Conversational turn handling for #chats threads and project stage
// threads. Called from index.js's message router before the DM-capture
// path. Returns true if the message was consumed.
//
// This file now only resolves the session and hands off to the agent
// loop (agent.js). The intent-classification cascade that used to live
// here (D-51 regex + confidence trailer, D-52 interrogative guard +
// momentum tagging + one-answer branching) is gone -- the agent gets
// the tool set and the thread context and decides for itself whether to
// run a command or just reply.

const { founderForUserId, channelId } = require("./config");
const {
	getSession,
	getOrCreateStageSession,
	addTurn,
} = require("./chat-session");
const { findIdeaByChannel } = require("./ideas");
const agent = require("./agent");

async function handleChatTurn({ message, client }) {
	if (message.bot_id) return false;
	if (!message.thread_ts) return false;

	const inChats = message.channel === channelId("chats");
	const project = inChats ? null : findIdeaByChannel(message.channel);
	if (!inChats && !project) return false;

	const speakerFounder = message.user ? founderForUserId(message.user) : null;

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

	if (inChats && (message.subtype === "file_share" || (message.files && message.files.length))) {
		const text = "I can't store files in a chat — start a project and I'll keep it with the idea.";
		await client.chat
			.postMessage({ channel: message.channel, thread_ts: session.threadTs, text })
			.catch(() => {});
		return true;
	}

	// file_share carries a subtype but may also carry a real instruction.
	// Everything else with a subtype (edits, joins, deletes) is not a turn.
	if (message.subtype && message.subtype !== "file_share") return false;
	if (!message.user || !message.text) return false;

	const speaker = founderForUserId(message.user);
	if (!speaker) return true;

	const text = message.text.trim();
	if (!text) return true;

	// PROTO ENTRY, BEFORE THE TURN IS RECORDED.
	//
	// A founder who switches to proto and starts talking before tapping
	// [ Let's Prototype ] gets a nudge, and that message is deliberately
	// NOT stored. The ordering is the whole point: addTurn drives
	// compaction (COMPACT_AT), the audit-reference compressor (every 5
	// turns) and the document sync watermarks, so a deflected message
	// recorded here would pollute all three with something the system
	// explicitly declined to act on.
	if (session.kind === "project" && session.ideaId) {
		const { sessionMode } = require("./chat-session");
		if (sessionMode(session) === "proto") {
			const protoFlow = require("./proto-flow");
			if (protoFlow.needsBootstrap(session.ideaId, session.threadTs)) {
				await protoFlow
					.deflect({ id: session.ideaId, chatTs: session.threadTs, client, channel: message.channel })
					.catch((err) => console.error(`proto: deflect failed for ${session.ideaId}: ${err.message}`));
				return true;
			}
			// Bootstrapped: a message in proto mode IS a change request. It
			// goes to the plan/build loop rather than the generic agent,
			// which has no idea a prototype is open.
			addTurn(session, { role: "user", text, userId: message.user, ts: message.ts });
			await require("./proto-turn")
				.handleProtoMessage({ session, message, client, text })
				.catch(async (err) => {
					console.error(`proto: turn failed for ${session.ideaId}: ${err.stack || err.message}`);
					await client.chat
						.postMessage({ channel: message.channel, thread_ts: session.threadTs, text: `That didn't work: ${err.message}` })
						.catch(() => {});
				});
			return true;
		}
	}

	addTurn(session, { role: "user", text, userId: message.user, ts: message.ts });

	// FIRST MESSAGE AFTER A MODE SWITCH.
	//
	// Two things happen before the agent replies, both so the DOCUMENT
	// carries context between stages rather than the raw thread doing it:
	//
	//  1. The mode the chat just left is brought up to date from this
	//     chat's conversation (doc-sync). After that the new mode reads a
	//     current upstream document and needs none of the old turns.
	//  2. If the new mode's own input document is missing, the founder is
	//     asked once whether to generate it -- on the FIRST MESSAGE rather
	//     than at switch time, so switching through modes to decide where
	//     to start doesn't spray offers into the thread.
	if (session.kind === "project" && session.ideaId) {
		const handled = await require("./mode-entry")
			.handleFirstMessage({ session, message, client })
			.catch((err) => {
				console.error(`mode-entry: first-message handling failed: ${err.message}`);
				return false;
			});
		// A pending auto-gen decision owns the turn -- the founder answers
		// the buttons before the persona speaks.
		if (handled) return true;
	}

	return agent.runTurn({ session, message, client });
}

module.exports = { handleChatTurn };
