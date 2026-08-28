"use strict";

// Block Kit for bot replies in chat threads: the always-present "Start a
// project from this idea" action (PROJECTS.md P2 / build-guide-projects
// 15.1) and, when the turn showed command intent, an appended one-tap
// offer (D-51). Own module, no deps, so chat-session.js, promotion.js and
// chat-turn.js can all use it without a require cycle.

const PROMOTE_ACTION_ID = "promote_chat";
const RUN_ACTION_ID = "run_suggested";

// action -> button label. Kept short; the icon carries recognition.
const OFFER_LABEL = {
	attack: "⚔️ Attack this idea",
	find: "🔎 Search the web",
	cross: "👥 Ask the others",
	blindspot: "🕳️ Find the blind spot",
	themes: "🔁 Show my themes",
	test: "🔬 Run research",
	proto: "🔨 Prototype it",
	spinoff: "🌱 Spin it off",
	audit: "⚖️ Send to the gate",
};

// text: the conversational reply (already trailer-stripped).
// opts.promote: attach the promote button (chat sessions only).
// opts.offer: { action, offeredAt, ideaId } | null -- attach the one-tap
//   command offer.
// opts.ttlMin: minutes until the offer expires (for the hint line).
function buildReplyBlocks(text, { promote = false, offer = null, threadTs, ttlMin = 120 } = {}) {
	const blocks = [{ type: "section", text: { type: "mrkdwn", text: String(text).slice(0, 2900) } }];

	const elements = [];
	if (promote) {
		elements.push({
			type: "button",
			action_id: PROMOTE_ACTION_ID,
			text: { type: "plain_text", text: "Start a project from this idea" },
			value: String(threadTs),
		});
	}
	if (offer && OFFER_LABEL[offer.action]) {
		elements.push({
			type: "button",
			action_id: RUN_ACTION_ID,
			text: { type: "plain_text", text: OFFER_LABEL[offer.action] },
			value: JSON.stringify({
				action: offer.action,
				threadTs: String(threadTs),
				offeredAt: offer.offeredAt || Date.now(),
				ideaId: offer.ideaId || null,
				// index of the user turn that triggered this offer -- the
				// tap runs the command against THAT turn's text, and the
				// offer goes stale once the conversation has moved past it.
				turnIndex: offer.turnIndex ?? null,
			}),
		});
	}
	if (elements.length) blocks.push({ type: "actions", block_id: "offer", elements });
	if (offer && OFFER_LABEL[offer.action]) {
		blocks.push({
			type: "context",
			elements: [
				{ type: "mrkdwn", text: `_or say \`@Mill ${offer.action}\` — this offer expires in ${ttlMin >= 60 ? `${Math.round(ttlMin / 60)}h` : `${ttlMin}m`}, ignoring it costs nothing_` },
			],
		});
	}
	return blocks;
}

// Back-compat: promote-only blocks (upload nudge, /attack chat branch,
// postCommandResult).
function withPromoteButton(text, threadTs) {
	return buildReplyBlocks(text, { promote: true, threadTs });
}

module.exports = { PROMOTE_ACTION_ID, RUN_ACTION_ID, OFFER_LABEL, buildReplyBlocks, withPromoteButton };
