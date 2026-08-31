"use strict";

// Project channels (docs/PROJECTS.md "Projects"). One channel per
// promoted idea, `#idea-<id>-<slug>`.
//
// Change 1 (docs/build-prompt-modes.md) supersedes D-47's five stage
// anchor threads with a single project thread and an explicit mode,
// persisted in state.json. Needs the channels:manage scope.

const { activeFounders, userIdForFounder } = require("./config");
const { PERSONAS, MODE_ORDER } = require("./personas");

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

const MODE_EMOJI = {
	brainstorm: "🧠",
	product: "📋",
	engineering: "🔧",
	proto: "🔨",
	deck: "📊",
	audit: "⚖️",
};

// Modes are sequential in dependency (each persona's input is the
// previous mode's document) but NOT in gating (Change 1's "modes do not
// gate each other", amended by the DECISIONS section to make clear the
// reversal is deliberate: switching is never blocked; a missing input
// document is Change 3's generate-or-switch offer, not a hard stop).
function modeBannerText(mode, { byFounder = null } = {}) {
	const persona = PERSONAS[mode];
	const emoji = MODE_EMOJI[mode] || "▶️";
	const who = byFounder ? ` — switched by ${byFounder}` : "";
	return `${emoji} *Mode: ${persona.label === "Co-founder" ? "Brainstorm" : mode[0].toUpperCase() + mode.slice(1)}* (${persona.label})${who}. Produces: ${persona.outputTitle || "artifacts"}.`;
}

// Creates the channel, invites every active founder, sets the topic to
// the assumption, posts the single anchor + starting mode banner. Throws
// on any failure -- the caller (promotion) must then create no idea
// (PROJECTS.md failure table).
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

	// No anchor messages: a project's entry point is its first CHAT, whose
	// card is that chat's thread root (chat-card.js). The caller creates it.
	return { channelId: channel, name, threads: {} };
}

module.exports = {
	slugify,
	channelName,
	createProjectChannel,
	modeBannerText,
	MODE_EMOJI,
	MODE_ORDER,
};
