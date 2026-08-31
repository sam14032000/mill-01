"use strict";

// Compatibility shim.
//
// This module used to own a single floating "current state" card posted
// at channel root. That design is superseded: a project now holds many
// chats, each chat's card IS its thread's root message (chat-card.js),
// and the pin follows the last active chat. The old card described a
// conversation that lived in a different thread, which is exactly the
// drift the new model removes by construction.
//
// Eight commands call `upsertStateCard(client, id, {latestTs})` after
// they post a result. Rather than edit every call site, this keeps that
// signature and routes it to the chat layer: refresh the card of the
// chat the work happened in (or the last active one), and move the pin
// there. `nextStep` and the lifecycle rendering are gone -- they encoded
// D-41's linear pipeline, which modes replaced.

const { readState } = require("./ideas");
const chats = require("./chats");
const { touchAndRepin, upsertChatCard } = require("./chat-card");

async function upsertStateCard(client, id, { chatTs = null, latestTs = null } = {}) {
	try {
		const state = readState(id);
		if (!state || !state.channel_id) return; // pre-projects idea: nothing to pin to
		// Prefer an explicit chat, then the thread the result landed in if
		// that is itself a chat, then whichever chat was last active.
		if (!Object.keys(chats.listChats(id)).length) chats.adoptLegacyThread(id);
		const target =
			(chatTs && chats.readChat(id, chatTs) && chatTs) ||
			(latestTs && chats.readChat(id, latestTs) && latestTs) ||
			chats.lastActiveChatTs(id);
		if (!target) return; // project has no chats yet
		await touchAndRepin(client, id, target, { latestTs });
	} catch (err) {
		console.error(`state-card: upsert failed for ${id}: ${err?.data?.error || err.message}`);
	}
}

module.exports = { upsertStateCard, upsertChatCard };
