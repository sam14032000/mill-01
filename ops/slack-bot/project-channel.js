"use strict";

// Project channels (docs/PROJECTS.md "Projects", build-guide-projects
// Part 16). One channel per promoted idea, `#idea-<id>-<slug>`, with five
// stage anchor threads. Needs the channels:manage scope.

const { activeFounders, userIdForFounder } = require("./config");

// Slack channel names: lowercase, [a-z0-9-_], <= 80 chars, no leading/
// trailing separators.
function slugify(text, maxLen) {
	const s = String(text || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLen)
		.replace(/-+$/g, "");
	return s || "idea";
}

function channelName(id, sourceText) {
	// "idea-" + id + "-" + slug, total <= 80.
	const prefix = `idea-${id}-`;
	return prefix + slugify(sourceText, 80 - prefix.length);
}

// The five stage anchors (16.2 / PROJECTS.md). Order matters -- stored by
// key in state.json.
const STAGE_ANCHORS = [
	["brainstorm", "🧠 *Brainstorm* — `/think` `/cross` `/blindspot` `/attack`, and just thinking out loud. Reply in this thread."],
	["research", "🔍 *Research* — `/test`, field evidence, and the reports it produces. Reply in this thread."],
	["audit", "⚖️ *Audit* — `/audit` verdicts. Reply in this thread."],
	["prototype", "🔨 *Prototype* — `/proto`, touches, mount/dismount. Reply in this thread."],
	["documents", "📎 *Documents* — upload files here and I'll keep them with the idea."],
];

const STAGE_KEYS = STAGE_ANCHORS.map(([k]) => k);

// Which stage thread a command belongs in (16.3).
const COMMAND_STAGE = {
	"/think": "brainstorm",
	"/cross": "brainstorm",
	"/blindspot": "brainstorm",
	"/attack": "brainstorm",
	"/themes": "brainstorm",
	"/test": "research",
	"/audit": "audit",
	"/proto": "prototype",
};

async function postAnchors(client, channel, assumption) {
	const threads = {};
	const header = assumption
		? `*Assumption under test:* ${assumption}`
		: "_No assumption yet — run `/attack` in Brainstorm, then `/test`._";
	await client.chat.postMessage({ channel, text: header });
	for (const [key, text] of STAGE_ANCHORS) {
		const posted = await client.chat.postMessage({ channel, text });
		threads[key] = posted.ts;
	}
	return threads;
}

// Creates the channel, invites every active founder, sets the topic to
// the assumption, posts the anchors. Throws on any failure -- the caller
// (promotion) must then create no idea (PROJECTS.md failure table).
async function createProjectChannel({ id, sourceText, assumption, client }) {
	const name = channelName(id, sourceText);

	const created = await client.conversations.create({ name, is_private: false });
	const channel = created.channel.id;

	const founderIds = activeFounders()
		.map((f) => userIdForFounder(f))
		.filter(Boolean);
	if (founderIds.length) {
		await client.conversations.invite({ channel, users: founderIds.join(",") }).catch((err) => {
			// already_in_channel for the creator is fine; anything else is
			// worth surfacing but not worth aborting a made channel.
			if (!/already_in_channel|cant_invite_self/.test(String(err?.data?.error || err))) {
				console.error(`project-channel: invite warning for ${channel}: ${err?.data?.error || err}`);
			}
		});
	}

	if (assumption) {
		await client.conversations
			.setTopic({ channel, topic: assumption.slice(0, 250) })
			.catch((err) => console.error(`project-channel: setTopic failed: ${err?.data?.error || err}`));
	}

	const threads = await postAnchors(client, channel, assumption);
	return { channelId: channel, name, threads };
}

// 16.3: if a stage thread_ts is missing or stale, repost all anchors and
// return the fresh map rather than ever posting to channel root.
async function repostAnchors({ client, channel, assumption }) {
	return postAnchors(client, channel, assumption);
}

module.exports = {
	slugify,
	channelName,
	createProjectChannel,
	repostAnchors,
	STAGE_KEYS,
	COMMAND_STAGE,
};
