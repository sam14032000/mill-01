"use strict";

// Pinned "current state" card, one per project channel (D-52 follow-up).
//
// Slack's thread-open scroll lands at the top of a long thread, with no
// API to change it -- so returning to a busy 28-turn project means
// scrolling to find where things stand. This card is the one message a
// returning founder reads instead: assumption (or what it's blocked on),
// current state, last verdict, what's next, a permalink to the latest
// activity. It is posted once, then `chat.update`d in place on every
// state transition -- never on a timer, never a second copy.
//
// The pin itself needs the `pins:write` scope. Until that's granted the
// card is still posted and kept current (and the channel topic, which
// only needs channels:manage, carries a one-line version that's always
// visible) -- adding the scope later makes it sticky with no code change.

const {
	readState,
	readAssumption,
	readLatestAudit,
	updateState,
} = require("./ideas");
const { toSlackMrkdwn } = require("./mrkdwn");

// One warning per process if the pin scope is missing -- don't spam the
// log on every transition.
let pinScopeWarned = false;

// What the founder should do next, from the idea's state. Phrased for
// threads (@Mill <cmd>), since that's how commands run inside a project.
function nextStep(state) {
	const s = state.state;
	const touches = state.touch_count || 0;
	switch (s) {
		case "killed":
			return "killed — this channel is archived. Nothing to do.";
		case "prototyping":
			return touches >= 5
				? "touch cap reached — decide whether you're building this (a different budget), or kill it"
				: `iterate in Prototype (\`@Mill proto\`, touch ${touches}/5), or re-audit with new evidence`;
		case "audited":
			return "prototype it — `@Mill proto <assumption>` in Prototype, or sharpen the assumption and re-test";
		case "researched":
			return "run `@Mill audit` in the Audit thread";
		case "open":
		default:
			if (state.assumption || state.has_assumption) return "run `@Mill test` in the Research thread";
			if (state.assumption_blocked_on) return `pin down in Brainstorm: ${state.assumption_blocked_on} — then \`@Mill attack\``;
			return "run `@Mill attack` in the Brainstorm thread to set a falsifiable assumption";
	}
}

function assumptionLine(state, assumption) {
	if (assumption) return `*Assumption:* ${assumption}`;
	if (state.assumption_blocked_on) return `*Assumption:* _not set — blocked on: ${state.assumption_blocked_on}_`;
	return "*Assumption:* _not set yet_";
}

function cardText(state, { assumption, audit, permalink }) {
	const lines = [
		`📍 *Idea \`${state.id}\`* · *${state.state}*${state.founder ? ` · ${state.founder}` : ""}`,
		assumptionLine(state, assumption),
	];
	if (audit) {
		const dg = audit.reason_code === "c07_downgraded_proceed_to_narrow" ? " _(downgraded)_" : "";
		lines.push(`*Last verdict:* ${audit.verdict} — ${audit.evidence_basis}${dg} · ${audit.stamp}`);
	}
	lines.push(`*Next:* ${nextStep(state)}`);
	if (permalink) lines.push(`*Latest activity:* <${permalink}|jump to the newest message>`);
	return lines.join("\n");
}

// The always-visible one-liner (channel header). channels:manage covers
// setTopic; no extra scope. ~250 char cap.
function topicText(state, assumption) {
	const head = assumption
		? assumption
		: state.assumption_blocked_on
			? `[no assumption — blocked on: ${state.assumption_blocked_on}]`
			: "[no assumption yet]";
	return `${state.state} · ${head}`.slice(0, 250);
}

// Post-or-update the card, refresh the topic. Best-effort throughout:
// a card failure must never break the command that triggered it.
// `latestTs` (+ optional `latestChannel`) is the message to permalink to
// -- normally the result the calling command just posted.
async function upsertStateCard(client, id, { latestTs = null, latestChannel = null } = {}) {
	try {
		const state = readState(id);
		if (!state || !state.channel_id) return; // pre-projects idea: nothing to pin to
		const assumption = readAssumption(id) || state.assumption || null;
		const audit = readLatestAudit(id);

		let permalink = null;
		if (latestTs) {
			permalink = await client.chat
				.getPermalink({ channel: latestChannel || state.channel_id, message_ts: latestTs })
				.then((r) => r.permalink)
				.catch(() => null);
		}

		const text = toSlackMrkdwn(cardText(state, { assumption, audit, permalink }));
		const blocks = [{ type: "section", text: { type: "mrkdwn", text } }];

		let cardTs = state.state_card_ts || null;
		if (cardTs) {
			try {
				await client.chat.update({ channel: state.channel_id, ts: cardTs, text, blocks });
			} catch (err) {
				const code = err?.data?.error || "";
				if (/message_not_found|cant_update_message/.test(code)) cardTs = null; // repost below
				else throw err;
			}
		}
		if (!cardTs) {
			const posted = await client.chat.postMessage({ channel: state.channel_id, text, blocks });
			cardTs = posted.ts;
			updateState(id, { state_card_ts: cardTs });
			await client.pins.add({ channel: state.channel_id, timestamp: cardTs }).catch((err) => {
				const code = err?.data?.error || "";
				if (code === "already_pinned") return;
				if (code === "missing_scope") {
					if (!pinScopeWarned) {
						console.error("state-card: pins.add needs the `pins:write` scope — card posted but not pinned. Add the scope and it sticks on next transition.");
						pinScopeWarned = true;
					}
					return;
				}
				console.error(`state-card: pin failed for ${id}: ${code || err.message}`);
			});
		}

		await client.conversations
			.setTopic({ channel: state.channel_id, topic: topicText(state, assumption) })
			.catch((err) => console.error(`state-card: setTopic failed for ${id}: ${err?.data?.error || err.message}`));
	} catch (err) {
		console.error(`state-card: upsert failed for ${id}: ${err?.data?.error || err.message}`);
	}
}

module.exports = { upsertStateCard, cardText, nextStep };
