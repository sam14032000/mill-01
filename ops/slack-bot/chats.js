"use strict";

// Chats within a project.
//
// A project channel holds MANY chats. Each chat is a Slack thread whose
// ROOT MESSAGE IS ITS CARD -- so a card and the conversation it describes
// are the same thread by construction, and cannot drift apart the way a
// floating channel-root card did.
//
// Mode is per chat, not per project: one chat can be a product-planning
// conversation while another in the same project is an engineering one.
// Documents stay project-level (a project has one product spec), so a
// chat in product mode edits the project's `product-spec.md`. The
// audit master report (`audit-reference.md`) is likewise project-level,
// which is what lets chats reference each other's reasoning.
//
// The registry lives in state.json under `chats`, keyed by the chat's
// thread_ts (which is also its card ts). `pinned_chat_ts` records which
// card currently holds the channel's pin -- the last active chat.

const { readState, updateState, nowIso } = require("./ideas");

function listChats(id) {
	const st = readState(id);
	return st?.chats || {};
}

function readChat(id, chatTs) {
	return listChats(id)[chatTs] || null;
}

// Creates the registry entry. The caller posts the card message first and
// passes its ts -- that ts is both the chat's thread and its card.
function createChat(id, chatTs, { title, mode = "brainstorm", createdBy = null }) {
	const chats = { ...listChats(id) };
	chats[chatTs] = {
		title: title || "Untitled chat",
		mode,
		created_by: createdBy,
		created_at: nowIso(),
		last_active_at: nowIso(),
	};
	const st = readState(id);
	updateState(id, { chats, active_chat_ts: chatTs, threads: { ...(st.threads || {}), project: chatTs } });
	return chats[chatTs];
}

function updateChat(id, chatTs, patch) {
	const chats = { ...listChats(id) };
	if (!chats[chatTs]) return null;
	chats[chatTs] = { ...chats[chatTs], ...patch };
	updateState(id, { chats });
	return chats[chatTs];
}

// Marks a chat as the most recently active. Pin movement is handled by
// the card layer (chat-card.js) so this stays pure state.
function touchChat(id, chatTs) {
	const chat = readChat(id, chatTs);
	if (!chat) return null;
	updateChat(id, chatTs, { last_active_at: nowIso() });
	// `threads.project` is kept mirroring the active chat so every existing
	// consumer that resolves "the project thread" (commandDestination,
	// documents, mount, staleness) keeps working without knowing about the
	// chat registry. The registry is the source of truth; this is a view.
	const st = readState(id);
	updateState(id, { active_chat_ts: chatTs, threads: { ...(st.threads || {}), project: chatTs } });
	return readChat(id, chatTs);
}

// The chat that should currently hold the pin: most recent last_active_at.
function lastActiveChatTs(id) {
	const chats = listChats(id);
	const entries = Object.entries(chats);
	if (!entries.length) return null;
	entries.sort((a, b) => String(b[1].last_active_at || "").localeCompare(String(a[1].last_active_at || "")));
	return entries[0][0];
}

// A chat's mode, defaulting to brainstorm (the mandatory entry point).
function chatMode(id, chatTs) {
	return readChat(id, chatTs)?.mode || "brainstorm";
}

// Backward compatibility: a project created before the chats model has a
// legacy `threads.project` thread and no registry. Adopt that thread as
// the project's first chat rather than requiring a migration step -- an
// old project must keep working the moment the new code deploys.
function adoptLegacyThread(id, { title = "Main", createdBy = null } = {}) {
	const st = readState(id);
	if (!st) return null;
	if (Object.keys(st.chats || {}).length) return null; // already has chats
	const legacy = st.threads?.project;
	if (!legacy) return null;
	return { chatTs: legacy, chat: createChat(id, legacy, { title, mode: st.mode || "brainstorm", createdBy: createdBy || st.founder || null }) };
}

// Is this thread_ts a chat in this project?
function isChatThread(id, threadTs) {
	return Boolean(threadTs && listChats(id)[threadTs]);
}

module.exports = {
	listChats,
	readChat,
	createChat,
	updateChat,
	touchChat,
	lastActiveChatTs,
	chatMode,
	isChatThread,
	adoptLegacyThread,
};
