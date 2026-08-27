"use strict";

// The "Start a project from this idea" Block Kit action (build-guide-
// projects 15.1). Its own module with no dependencies so both
// chat-session.js (which attaches it to command output) and promotion.js
// (which handles the click) can use it without a require cycle.

const PROMOTE_ACTION_ID = "promote_chat";

// Wraps plain text in blocks with the promote button appended. Slack
// section text caps at 3000 chars; longer replies are truncated in the
// block but the full text is still sent as the `text` fallback by the
// caller.
function withPromoteButton(text, threadTs) {
	return [
		{ type: "section", text: { type: "mrkdwn", text: String(text).slice(0, 2900) } },
		{
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
		},
	];
}

module.exports = { PROMOTE_ACTION_ID, withPromoteButton };
