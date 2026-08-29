"use strict";

// Block Kit for bot replies in chat threads: the always-present "Start a
// project from this idea" action (PROJECTS.md P2 / build-guide-projects
// 15.1). Own module, no deps, so chat-session.js, promotion.js and the
// agent loop can all use it without a require cycle.
//
// The one-tap intent "offer" that used to live here (D-51) is gone --
// the agent loop decides whether to run a command; there's nothing to
// offer.

const PROMOTE_ACTION_ID = "promote_chat";

// text: the reply body. opts.promote: attach the promote button
// (chat sessions only).
function buildReplyBlocks(text, { promote = false, threadTs } = {}) {
	const blocks = [{ type: "section", text: { type: "mrkdwn", text: String(text).slice(0, 2900) } }];
	if (promote) {
		blocks.push({
			type: "actions",
			block_id: "promote",
			elements: [
				{
					type: "button",
					action_id: PROMOTE_ACTION_ID,
					text: { type: "plain_text", text: "Start a project from this idea" },
					value: String(threadTs),
				},
			],
		});
	}
	return blocks;
}

function withPromoteButton(text, threadTs) {
	return buildReplyBlocks(text, { promote: true, threadTs });
}

module.exports = { PROMOTE_ACTION_ID, buildReplyBlocks, withPromoteButton };
