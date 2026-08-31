"use strict";

// What happens on the FIRST MESSAGE after a mode switch.
//
// Deliberately on the first message rather than at switch time. A founder
// deciding where to start often steps through several modes in a row;
// firing an offer on each switch would fill the thread with questions
// about decisions they hadn't made yet. Nothing is asked until they
// actually start working in a mode.
//
// Order matters. The upstream sync runs FIRST, so that when a missing
// document is then generated it is built from a current upstream document
// rather than a stale one. That is the whole point of the sequence: for a
// stage skip (brainstorm -> engineering with no product spec), the
// research KB is brought up to date with the brainstorm conversation
// before the product spec is generated from it — so the generated spec
// reflects what was actually discussed without needing the raw chat.

const { personaFor } = require("./personas");
const { checkMissingInput } = require("./mode-docflow");
const { syncPreviousMode } = require("./doc-sync");
const chats = require("./chats");

// A chat waiting on the founder's answer to the auto-gen question.
// Stored on the chat record so it survives a restart.
function pendingDecision(id, chatTs) {
	return chats.readChat(id, chatTs)?.pending_autogen || null;
}

function autogenBlocks(id, chatTs, offer) {
	const enteringLabel = personaFor(offer.mode).label;
	const text =
		`*${offer.mode[0].toUpperCase() + offer.mode.slice(1)}* normally works from a ${offer.missingTitle.toLowerCase()}, ` +
		`and there isn't one.\nI can draft it from what the project already knows, or you can switch to ` +
		`*${offer.missingMode}* and write it properly first.`;
	return {
		text,
		blocks: [
			{ type: "section", text: { type: "mrkdwn", text } },
			{
				type: "actions",
				block_id: "autogen_decision",
				elements: [
					{ type: "button", action_id: "autogen_yes", style: "primary", text: { type: "plain_text", text: `Draft the ${offer.missingTitle.toLowerCase()}` }, value: `${id}::${chatTs}::${offer.missingMode}` },
					{ type: "button", action_id: "autogen_no", text: { type: "plain_text", text: `Switch to ${offer.missingMode}` }, value: `${id}::${chatTs}::${offer.missingMode}` },
				],
			},
		],
	};
}

// Returns true when this turn has been consumed (the founder owes an
// answer before the persona speaks).
async function handleFirstMessage({ session, message, client }) {
	const id = session.ideaId;
	const chatTs = session.threadTs;
	const chat = chats.readChat(id, chatTs);
	if (!chat) return false;

	// Already waiting on an answer: don't ask twice, don't sync again.
	if (pendingDecision(id, chatTs)) return false;

	const mode = chat.mode || "brainstorm";
	const channel = message.channel;

	// 1. Bring the mode we just left up to date from this chat. Runs before
	//    any generation so a skipped stage is generated from current input.
	if (chat.prev_mode) {
		await syncPreviousMode({ id, chatTs, client, channel, threadTs: chatTs }).catch((err) =>
			console.error(`mode-entry: sync of ${chat.prev_mode} failed for ${id}: ${err.message}`),
		);
	}

	// 2. Does the mode we are now in have its input document?
	const missing = checkMissingInput(id, mode);
	if (!missing) return false;

	const { text, blocks } = autogenBlocks(id, chatTs, missing);
	await client.chat.postMessage({ channel, thread_ts: chatTs, text, blocks }).catch(() => {});
	chats.updateChat(id, chatTs, { pending_autogen: { mode, missingMode: missing.missingMode, askedAt: Date.now() } });
	return true; // the founder answers before the persona replies
}

function clearPending(id, chatTs) {
	chats.updateChat(id, chatTs, { pending_autogen: null });
}

module.exports = { handleFirstMessage, pendingDecision, clearPending, autogenBlocks };
