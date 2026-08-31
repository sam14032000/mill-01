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

// Single anchor: one root message the project thread hangs off, plus the
// initial mode banner. Returns { project: ts } -- the one thread_ts every
// command and every conversational turn in this project now uses.
async function postProjectAnchor(client, channel, assumption, id) {
	const header = assumption
		? `*Assumption under test:* ${assumption}`
		: "_No assumption yet — brainstorm mode is where one gets set (`@Mill attack`)._";
	const root = await client.chat.postMessage({ channel, text: header });
	const banner = await client.chat.postMessage({
		channel,
		thread_ts: root.ts,
		text: modeBannerText("brainstorm"),
		blocks: [
			{ type: "section", text: { type: "mrkdwn", text: modeBannerText("brainstorm") } },
			...(id ? modeSwitchBlocks(id, "brainstorm") : []),
		],
	});
	// bannerTs is returned so the caller can record it as mode_banner_ts --
	// the first switch needs to know which row to retire (mode-switch.js).
	return { project: root.ts, bannerTs: banner?.ts || null };
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

	// bannerTs is kept OUT of `threads` -- that map is persisted verbatim
	// into state.json and must contain thread ids only.
	const { project, bannerTs } = await postProjectAnchor(client, channel, assumption, id);
	return { channelId: channel, name, threads: { project }, bannerTs };
}

// If the project thread_ts is missing or stale, repost the single anchor
// and return the fresh map rather than ever posting to channel root.
async function repostAnchor({ client, channel, assumption, id }) {
	const { project } = await postProjectAnchor(client, channel, assumption, id);
	return { project };
}

// One-tap mode switch row, attached to every mode banner (Change 1:
// "changed by command or button"). The current mode's button is marked
// so the row still communicates state even before a tap.
// Slack requires action_id to be unique WITHIN a block -- found live
// (invalid_blocks) migrating f05e, where all five buttons shared the
// plain "mode_switch" action_id in one row. Each button gets its own
// action_id (mode_switch_<mode>); index.js registers one handler against
// all of them via a regex match, and every handler reads the mode back
// out of `value` (`<id>::<mode>`), not the action_id, so routing is
// unaffected.
function modeSwitchBlocks(id, currentMode) {
	return [
		{
			type: "actions",
			block_id: "mode_switch",
			elements: MODE_ORDER.map((mode) => ({
				type: "button",
				action_id: `mode_switch_${mode}`,
				value: `${id}::${mode}`,
				text: { type: "plain_text", text: `${MODE_EMOJI[mode] || ""} ${mode === currentMode ? `[${mode}]` : mode}`.trim() },
				...(mode === currentMode ? { style: "primary" } : {}),
			})),
		},
	];
}

module.exports = {
	slugify,
	channelName,
	createProjectChannel,
	repostAnchor,
	modeBannerText,
	modeSwitchBlocks,
	MODE_EMOJI,
	MODE_ORDER,
};
