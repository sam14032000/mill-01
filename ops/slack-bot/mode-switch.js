"use strict";

// Change 1 (docs/build-prompt-modes.md): mode is persisted in
// state.json, displayed in-thread on every switch, and changed by
// command (`@Mill mode <name>`) or button (`mode_switch` action).
//
// Modes are sequential in dependency (each persona's input document is
// the previous mode's output) but not in gating -- switching to any mode
// is always allowed. A missing input document is Change 3's
// generate-or-switch offer, never a hard stop here.

const { MODE_ORDER, personaFor } = require("./personas");
const { readState, updateState, readLatestAudit } = require("./ideas");
const chats = require("./chats");
const { modeBannerText } = require("./project-channel");
const { checkMissingInput, checkStale, staleDocBlocks } = require("./mode-docflow");

const SWITCHABLE_MODES = MODE_ORDER; // brainstorm, product, engineering, proto, audit

function isValidMode(mode) {
	return SWITCHABLE_MODES.includes(mode);
}

// Returns { ok, mode?, reason? }. Never throws -- callers post the
// outcome themselves (buttons resolve through button-resolve.js; the
// `@Mill mode` command posts plainly).
// `chatTs` identifies WHICH chat's mode is changing -- mode is per chat
// (a project can have a product-planning chat and an engineering chat at
// once), so this never writes a project-level mode.
async function switchMode({ id, mode, client, channel, threadTs, byFounder, chatTs = null }) {
	if (!isValidMode(mode)) {
		return { ok: false, reason: `unknown mode "${mode}" — one of: ${SWITCHABLE_MODES.join(", ")}` };
	}
	const state = readState(id);
	if (!state) return { ok: false, reason: `no such idea \`${id}\`` };
	if (state.state === "killed") return { ok: false, reason: `\`${id}\` is killed — nothing to switch` };

	// An old project may have no chat registry yet -- adopt its legacy
	// thread as the first chat so switching works without a migration.
	if (!Object.keys(chats.listChats(id)).length) chats.adoptLegacyThread(id);
	const targetChat = chatTs || threadTs || chats.lastActiveChatTs(id);
	if (!targetChat || !chats.readChat(id, targetChat)) {
		return { ok: false, reason: "no chat to switch — open a chat in this project first (`@Mill chat <title>`)" };
	}
	const previousMode = chats.chatMode(id, targetChat);
	// prev_mode is what the first message in the new mode syncs from.
	chats.updateChat(id, targetChat, { mode, ...(previousMode && previousMode !== mode ? { prev_mode: previousMode } : {}) });

	const bannerChannel = channel || state.channel_id;
	const bannerThread = targetChat;
	if (client && bannerChannel) {
		// Plain text, no control -- the mode control lives on the card.
		//
		// And if NOTHING has been said since the last banner, edit that one
		// in place instead of posting another. Switching brainstorm ->
		// product -> engineering while deciding where to start would
		// otherwise leave three banners narrating a decision the founder
		// made in one motion. The turn count at post time is the test:
		// unchanged means nobody has spoken since.
		const text = modeBannerText(mode, { byFounder });
		const chat = chats.readChat(id, targetChat);
		const { getSession } = require("./chat-session");
		const turnsNow = getSession(targetChat)?.turns?.length ?? 0;
		const canEditInPlace = chat?.banner_ts && chat.banner_at_turn === turnsNow;

		if (canEditInPlace) {
			const edited = await client.chat
				.update({ channel: bannerChannel, ts: chat.banner_ts, text })
				.then(() => true)
				.catch((e) => {
					console.error(`mode-switch: banner edit failed for ${id}: ${e?.data?.error || e.message}`);
					return false;
				});
			if (edited) chats.updateChat(id, targetChat, { banner_at_turn: turnsNow });
			else await postFreshBanner();
		} else {
			await postFreshBanner();
		}

		async function postFreshBanner() {
			const posted = await client.chat
				.postMessage({ channel: bannerChannel, thread_ts: bannerThread, text })
				.catch((e) => {
					console.error(`mode-switch: banner post failed for ${id}: ${e?.data?.error || e.message}`);
					return null;
				});
			if (posted?.ts) chats.updateChat(id, targetChat, { banner_ts: posted.ts, banner_at_turn: turnsNow });
		}
	}

	// Re-render THIS chat's card (its root message) so the ✓ moves --
	// that re-render is the feedback a mode selection gives.
	try {
		const { touchAndRepin } = require("./chat-card");
		await touchAndRepin(client, id, targetChat);
	} catch (e) {
		console.error(`mode-switch: chat card refresh failed for ${id}: ${e.message}`);
	}

	// The missing-input offer used to fire HERE, at switch time. It now
	// fires on the first message (mode-entry.js): a founder stepping
	// through modes to decide where to start was getting an offer per
	// switch, about work they had not begun. Staleness is still checked
	// here, because a stale document is a fact about the project rather
	// than a question about the founder's intent.
	let docOffer = null;
	if (client && bannerChannel && !checkMissingInput(id, mode)) {
		const stale = await checkStale(id, mode).catch((e) => {
			console.error(`mode-switch: staleness check failed for ${id}/${mode}: ${e.message}`);
			return null;
		});
		if (stale && stale.stale) {
			const { text, blocks } = staleDocBlocks(id, mode, stale);
			await client.chat.postMessage({ channel: bannerChannel, thread_ts: bannerThread, text, blocks }).catch(() => {});
			docOffer = { kind: "stale", mode, report: stale };
		}
	}

	// Change 4: "One suggestion, before proto — offered once, ignorable,
	// in the same shape as the surface-search offer. This is the only
	// prompt to audit anywhere in the system." Audit is entered, not
	// triggered (Change 4), so nothing else in the mill ever nudges
	// toward it -- without this, an idea can go brainstorm -> proto with
	// nothing ever asking whether it should die first.
	//
	// Offered exactly once per idea: the first time proto mode is
	// entered with no audit verdict on file yet. Recorded in state.json
	// (`audit_suggested`) the moment it's shown, not on a tap -- so it
	// never repeats whether or not the founder acts on it. Ignorable by
	// construction: switching to proto already happened above: this
	// suggestion cannot block or undo it.
	if (mode === "proto" && !readState(id).audit_suggested && !readLatestAudit(id)) {
		updateState(id, { audit_suggested: true });
		if (client && bannerChannel) {
			const text =
				"💡 No audit has run on this idea yet. Worth running one before building — a kill here is cheaper " +
				"than a kill after a prototype. Entirely optional; proto mode is already switched either way.";
			await client.chat
				.postMessage({
					channel: bannerChannel,
					thread_ts: bannerThread,
					text,
					blocks: [
						{ type: "section", text: { type: "mrkdwn", text } },
						{
							type: "actions",
							block_id: "audit_suggestion",
							elements: [
								{ type: "button", action_id: "audit_suggestion_switch", style: "primary", text: { type: "plain_text", text: "Switch to audit" }, value: id },
								{ type: "button", action_id: "audit_suggestion_dismiss", text: { type: "plain_text", text: "Continue to proto" }, value: id },
							],
						},
					],
				})
				.catch((e) => console.error(`mode-switch: audit suggestion post failed for ${id}: ${e?.data?.error || e.message}`));
		}
	}

	return { ok: true, mode, persona: personaFor(mode), docOffer };
}

module.exports = { switchMode, isValidMode, SWITCHABLE_MODES };
