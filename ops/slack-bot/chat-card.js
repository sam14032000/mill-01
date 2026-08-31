"use strict";

// The card for one chat inside a project.
//
// THE CARD IS THE CHAT THREAD'S ROOT MESSAGE. Replies to it are the
// conversation. This is the fix for the split that the previous design
// had: a floating channel-root card described a conversation living in a
// different thread, so the two drifted and a founder reading the card was
// not looking at the chat it referred to.
//
// The pin follows the LAST ACTIVE chat -- exactly one card is pinned per
// project at a time, so the channel's pin always points at where work is
// happening.
//
// Deliberately NOT shown (legacy, superseded by modes):
//   * the `open/researched/audited/prototyping` lifecycle from D-41's
//     linear pipeline, and
//   * a prescribed "Next: run <command>" line.
// Both encoded the pipeline the mode model replaced, and both went stale
// on their own (a card kept telling a founder to run `@Mill test` on an
// idea whose thread had moved well past that). What a founder needs is
// where this chat is (mode), what the project is testing (assumption),
// what documents exist, and the shared audit master report.

const fs = require("node:fs");
const path = require("node:path");
const { readState, readAssumption, updateState, IDEAS_DIR } = require("./ideas");
const { toSlackMrkdwn } = require("./mrkdwn");
const chats = require("./chats");

let pinScopeWarned = false;

function docsLine(id) {
	try {
		const { readDoc } = require("./mode-docs");
		const chain = [
			["brainstorm", "research KB"],
			["product", "product spec"],
			["engineering", "engineering spec"],
		];
		return `*Docs:* ${chain.map(([m, label]) => (readDoc(id, m) ? `✓ ${label}` : `— ${label}`)).join(" · ")}`;
	} catch {
		return null;
	}
}

// The project-level audit master report, shared by every chat -- this is
// the line that makes "chats can reference each other's report" visible
// rather than merely true.
function auditReportLine(id) {
	const p = path.join(IDEAS_DIR, id, "audit-reference.md");
	if (!fs.existsSync(p)) return "*Audit master report:* _not started_";
	const entries = (fs.readFileSync(p, "utf8").match(/^### /gm) || []).length;
	return `*Audit master report:* \`ideas/${id}/audit-reference.md\` — ${entries} entr${entries === 1 ? "y" : "ies"}, shared across every chat in this project`;
}

// The mode control.
//
// Was an overflow (⋮). Compact, but opaque: a founder reported seeing the
// icon without any idea it was the mode switcher, which is a real failure
// -- a control nobody recognises is not a control. A static_select shows
// its own current value, so the card renders a tappable "🧠 brainstorm"
// that reads as both the current state and the way to change it. Same
// single element, same per-chat targeting; it just says what it is.
//
// The mode also stays in the card TEXT, because pinned previews and
// notifications render `text` without accessories -- the select alone
// would leave those silent about which mode a chat is in.
function modeSelect(id, chatTs, currentMode) {
	try {
		const { MODE_ORDER } = require("./personas");
		const { MODE_EMOJI } = require("./project-channel");
		const opt = (m) => ({
			text: { type: "plain_text", text: `${MODE_EMOJI[m] || "▶️"} ${m}`, emoji: true },
			value: `${id}::${chatTs}::${m}`,
		});
		const options = MODE_ORDER.map(opt);
		const current = MODE_ORDER.includes(currentMode) ? currentMode : "brainstorm";
		return {
			type: "static_select",
			action_id: "mode_overflow", // unchanged: same handler, same payload shape
			placeholder: { type: "plain_text", text: "Change mode", emoji: true },
			// initial_option must deep-match one of `options` or Slack rejects it.
			initial_option: opt(current),
			options,
		};
	} catch {
		return undefined;
	}
}

// The mode is deliberately NOT repeated in the heading: the select
// accessory already displays it, and showing the same value twice on one
// card is noise. The control is the status display.
function cardText(id, chatTs, chat) {
	const state = readState(id);
	const assumption = readAssumption(id) || state?.assumption || null;
	const lines = [
		`💬 *${chat.title}*${chat.created_by ? ` · ${chat.created_by}` : ""}`,
		assumption ? `*Assumption:* ${assumption}` : "*Assumption:* _not set yet_",
	];
	const docs = docsLine(id);
	if (docs) lines.push(docs);
	lines.push(auditReportLine(id));
	return lines.join("\n");
}

function cardBlocks(id, chatTs, chat) {
	const text = toSlackMrkdwn(cardText(id, chatTs, chat));
	return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text }, accessory: modeSelect(id, chatTs, chat.mode) }] };
}

// Creates a new chat: posts its card as a channel-root message (which
// becomes the thread others reply into), registers it, and pins it as the
// now-active chat.
async function createChatCard(client, id, { title, createdBy, mode = "brainstorm" }) {
	const state = readState(id);
	if (!state?.channel_id) throw new Error(`createChatCard: idea ${id} has no channel`);
	// Post a placeholder to obtain a ts, then render the real card into it
	// -- the card's own overflow value must contain its ts, which isn't
	// known until the message exists.
	const posted = await client.chat.postMessage({ channel: state.channel_id, text: `💬 ${title}` });
	const chat = chats.createChat(id, posted.ts, { title, mode, createdBy });
	const { text, blocks } = cardBlocks(id, posted.ts, chat);
	await client.chat.update({ channel: state.channel_id, ts: posted.ts, text, blocks });
	await repin(client, id, posted.ts);
	return { chatTs: posted.ts, chat };
}

// Re-render one chat's card in place.
async function upsertChatCard(client, id, chatTs) {
	const state = readState(id);
	const chat = chats.readChat(id, chatTs);
	if (!state?.channel_id || !chat) return null;
	const { text, blocks } = cardBlocks(id, chatTs, chat);
	await client.chat
		.update({ channel: state.channel_id, ts: chatTs, text, blocks })
		.catch((e) => console.error(`chat-card: update failed for ${id}/${chatTs}: ${e?.data?.error || e.message}`));
	return chat;
}

// Exactly one pinned card per project: the last active chat. Unpins the
// previous one so the channel pin is unambiguous.
async function repin(client, id, chatTs) {
	const state = readState(id);
	if (!state?.channel_id) return;
	const prev = state.pinned_chat_ts;
	if (prev === chatTs) return;
	if (prev) {
		await client.pins.remove({ channel: state.channel_id, timestamp: prev }).catch((e) => {
			const code = e?.data?.error || "";
			if (code !== "no_pin" && code !== "message_not_found") console.error(`chat-card: unpin failed: ${code}`);
		});
	}
	const ok = await client.pins
		.add({ channel: state.channel_id, timestamp: chatTs })
		.then(() => true)
		.catch((e) => {
			const code = e?.data?.error || "";
			if (code === "already_pinned") return true;
			if (code === "missing_scope") {
				if (!pinScopeWarned) {
					console.error("chat-card: pins.add needs `pins:write` — card posted but not pinned.");
					pinScopeWarned = true;
				}
				return false;
			}
			console.error(`chat-card: pin failed: ${code || e.message}`);
			return false;
		});
	if (ok) updateState(id, { pinned_chat_ts: chatTs });
}

// Called whenever something happens in a chat: bumps last_active_at,
// moves the pin, and re-renders the card.
async function touchAndRepin(client, id, chatTs) {
	if (!chats.readChat(id, chatTs)) return null;
	chats.touchChat(id, chatTs);
	await upsertChatCard(client, id, chatTs);
	await repin(client, id, chatTs);
	return chats.readChat(id, chatTs);
}

module.exports = { createChatCard, upsertChatCard, touchAndRepin, repin, cardText, cardBlocks, docsLine, auditReportLine };
