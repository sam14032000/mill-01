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
const { commitAndPush } = require("./git");

// One warning per process if the pin scope is missing -- don't spam the
// log on every transition.
let pinScopeWarned = false;

// What the founder should do next. Reads BOTH state and mode: with modes
// driving which persona answers (D-54), a state-only next-step can tell a
// founder sitting in engineering mode to "run `@Mill test`", which is a
// different mode's job entirely. The mode's own unmet precondition wins
// when there is one, because that is what is actually blocking them.
function nextStep(state) {
	const s = state.state;
	const touches = state.touch_count || 0;

	if (s === "killed") return "killed — this channel is archived. Nothing to do.";

	// Mode-first: if the current mode's input document is missing, that is
	// the immediate blocker regardless of lifecycle state.
	const mode = state.mode || "brainstorm";
	if (mode !== "brainstorm" && mode !== "audit") {
		try {
			const { checkMissingInput } = require("./mode-docflow");
			const missing = checkMissingInput(state.id, mode);
			if (missing) {
				return `in *${mode}* mode with no ${missing.missingTitle.toLowerCase()} — generate one or switch to *${missing.missingMode}* to write it`;
			}
		} catch {
			/* mode-docflow unavailable: fall through to the state-based step */
		}
	}

	switch (s) {
		case "prototyping":
			return touches >= 5
				? "touch cap reached — decide whether you're building this (a different budget), or kill it"
				: `iterate (\`@Mill proto\`, touch ${touches}/5, in Proto mode), or re-audit with new evidence`;
		case "audited":
			return "prototype it — switch to Proto mode and `@Mill proto <assumption>`, or sharpen the assumption and re-test";
		case "researched":
			return "switch to Audit mode and ask for the verdict when ready";
		case "open":
		default:
			if (state.assumption || state.has_assumption) return "run `@Mill test`";
			if (state.assumption_blocked_on) return `pin down: ${state.assumption_blocked_on} — then \`@Mill attack\``;
			return "run `@Mill attack` (Brainstorm mode) to set a falsifiable assumption";
	}
}

// The staged-document chain at a glance (D-54's feeding rule). A founder
// returning to a project needs to know which documents exist before they
// know which mode is worth entering -- the card is the one message they
// read, so it carries the chain.
function docsLine(id) {
	try {
		const { readDoc } = require("./mode-docs");
		// Short, consistently-cased labels -- the persona outputTitles are
		// sentence-case ("Product spec") and mixing them with "research KB"
		// reads as a rendering bug on the card.
		const chain = [
			["brainstorm", "research KB"],
			["product", "product spec"],
			["engineering", "engineering spec"],
		];
		const parts = chain.map(([m, label]) => (readDoc(id, m) ? `✓ ${label}` : `— ${label}`));
		return `*Docs:* ${parts.join(" · ")}`;
	} catch {
		return null;
	}
}

function assumptionLine(state, assumption) {
	if (assumption) return `*Assumption:* ${assumption}`;
	if (state.assumption_blocked_on) return `*Assumption:* _not set — blocked on: ${state.assumption_blocked_on}_`;
	return "*Assumption:* _not set yet_";
}

function cardText(state, { assumption, audit, permalink }) {
	const lines = [
		`📍 *Idea \`${state.id}\`* · *${state.state}*${state.founder ? ` · ${state.founder}` : ""}${state.mode ? ` · mode: ${state.mode}` : ""}`,
		assumptionLine(state, assumption),
	];
	const docs = docsLine(state.id);
	if (docs) lines.push(docs);
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
//
// Carries the MODE: the topic is the only indicator visible without
// opening anything, and under D-54 the mode determines which persona
// answers you -- omitting it left the one always-visible line silent
// about the thing that now governs the project's behaviour.
function topicText(state, assumption) {
	const head = assumption
		? assumption
		: state.assumption_blocked_on
			? `[no assumption — blocked on: ${state.assumption_blocked_on}]`
			: "[no assumption yet]";
	const mode = state.mode ? ` · ${state.mode}` : "";
	return `${state.state}${mode} · ${head}`.slice(0, 250);
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
				// Re-assert the pin on the update path too. It was previously
				// only attempted at first post, so a pin that failed once
				// (transient error, or the scope granted later) stayed unpinned
				// forever -- the card exists, so the repost branch never runs
				// again. already_pinned is the normal case here and is ignored.
				await client.pins.add({ channel: state.channel_id, timestamp: cardTs }).catch(() => {});
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
			// The state.json write above must reach the repo -- callers
			// commit their own paths at varying points (some before the card
			// exists), so commit it here rather than rely on the next one.
			await commitAndPush(
				[`ideas/${id}/state.json`],
				`idea ${id}: state card`,
				(reason) => console.error(`state-card: commit failed for ${id}: ${reason}`),
			);
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

		// Only set the topic when it actually changed. Slack posts a
		// `channel_topic` system message into the channel on every
		// successful setTopic, even when the value is identical -- and this
		// function runs on EVERY state transition, so the unconditional call
		// was steadily filling the channel with "set the channel topic:"
		// lines (four of them in f05e before this fix). The last value is
		// tracked in state.json rather than re-read from Slack, so the guard
		// costs no API call.
		const nextTopic = topicText(state, assumption);
		if (nextTopic !== state.topic_text) {
			const ok = await client.conversations
				.setTopic({ channel: state.channel_id, topic: nextTopic })
				.then(() => true)
				.catch((err) => {
					console.error(`state-card: setTopic failed for ${id}: ${err?.data?.error || err.message}`);
					return false;
				});
			if (ok) updateState(id, { topic_text: nextTopic });
		}
	} catch (err) {
		console.error(`state-card: upsert failed for ${id}: ${err?.data?.error || err.message}`);
	}
}

module.exports = { upsertStateCard, cardText, nextStep };
