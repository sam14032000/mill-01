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
const { checkMissingInput, missingDocBlocks, checkStale, staleDocBlocks } = require("./mode-docflow");

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
	chats.updateChat(id, targetChat, { mode });

	const bannerChannel = channel || state.channel_id;
	const bannerThread = targetChat;
	if (client && bannerChannel) {
		// Plain text, no control. The mode control lives on the pinned card
		// (state-card.js modeOverflow) -- posting one into the thread on
		// every switch is what made rows accumulate and go stale.
		const text = modeBannerText(mode, { byFounder });
		await client.chat
			.postMessage({ channel: bannerChannel, thread_ts: bannerThread, text })
			.catch((e) => console.error(`mode-switch: banner post failed for ${id}: ${e?.data?.error || e.message}`));
	}

	// Re-render THIS chat's card (its root message) so the ✓ moves --
	// that re-render is the feedback a mode selection gives.
	try {
		const { touchAndRepin } = require("./chat-card");
		await touchAndRepin(client, id, targetChat);
	} catch (e) {
		console.error(`mode-switch: chat card refresh failed for ${id}: ${e.message}`);
	}

	// Change 3: entering a mode whose input document doesn't exist offers
	// generate-or-switch instead of proceeding silently. Checked ahead of
	// staleness -- a document that doesn't exist can't be stale.
	let docOffer = null;
	const missing = checkMissingInput(id, mode);
	if (missing && client && bannerChannel) {
		const { text, blocks } = missingDocBlocks(id, missing);
		await client.chat.postMessage({ channel: bannerChannel, thread_ts: bannerThread, text, blocks }).catch(() => {});
		docOffer = { kind: "missing", ...missing };
	} else if (client && bannerChannel) {
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
