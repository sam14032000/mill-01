"use strict";

// I4: ideas move or die. Nothing else enforces motion -- an idea can sit
// at `researched` forever, and a parked idea is parked attention. A daily
// sweep nudges any idea stuck pre-verdict for 14 days, once; again at 30;
// then stops. The nudge carries a [Kill it] button that records `stale`
// as the reason -- a legitimate verdict: an idea nobody has returned to
// in two weeks has been answered by inattention.

const fs = require("node:fs");
const { IDEAS_DIR, readState, updateState, readAssumption } = require("./ideas");
const { appendToGraveyard } = require("./commands/audit");
const { emit } = require("./telemetry");
const { buildEvalEvent } = require("./eval-event");

const NUDGE_DAYS = [14, 30];
const STALE_STATES = new Set(["open", "researched"]);
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly poll; acts at most once/idea/day
const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(iso) {
	return (Date.now() - new Date(iso).getTime()) / DAY_MS;
}

// Which nudge threshold (if any) this idea has crossed but not yet been
// nudged for.
function pendingNudge(state) {
	if (!STALE_STATES.has(state.state)) return null;
	const age = daysSince(state.updated_at || state.created_at);
	const done = new Set(state.stale_nudges || []);
	for (const d of NUDGE_DAYS) {
		if (age >= d && !done.has(d)) return d;
	}
	return null;
}

async function sweepStaleIdeas(client, { includeTestIdeas = false } = {}) {
	let dirs;
	try {
		dirs = fs.readdirSync(IDEAS_DIR);
		if (!includeTestIdeas) dirs = dirs.filter((d) => !/^zz/i.test(d));
	} catch {
		return { checked: 0, nudged: 0 };
	}
	let nudged = 0;
	for (const id of dirs) {
		const st = readState(id);
		if (!st) continue;
		const threshold = pendingNudge(st);
		if (threshold == null) continue;

		const channel = st.channel_id;
		const threadTs = st.threads?.brainstorm || st.threads?.research;
		const ageDays = Math.floor(daysSince(st.updated_at || st.created_at));
		const text =
			`\`${id}\` has been at \`${st.state}\` for ${ageDays} days.\n` +
			(st.state === "researched" ? `\`/audit ${id}\`` : `\`/attack ${id}\` then \`/test\``) +
			" — or kill it and take the attention back.";

		if (channel) {
			await client.chat
				.postMessage({
					channel,
					...(threadTs ? { thread_ts: threadTs } : {}),
					text,
					blocks: [
						{ type: "section", text: { type: "mrkdwn", text } },
						{ type: "actions", elements: [{ type: "button", action_id: "stale_kill", style: "danger", text: { type: "plain_text", text: "Kill it" }, value: id }] },
					],
				})
				.catch((e) => console.error(`staleness: nudge post failed for ${id}: ${e?.data?.error || e.message}`));
		}

		updateState(id, { stale_nudges: [...(st.stale_nudges || []), threshold] });
		emit(buildEvalEvent({ stage: "staleness", ideaId: id, founder: st.founder, status: "ok", reasonCode: `nudge_${threshold}d` }));
		nudged += 1;
	}
	return { checked: dirs.length, nudged };
}

// Kill on the [Kill it] button. reason is always "stale".
async function killStale({ id, client }) {
	const st = readState(id);
	if (!st || st.state === "killed") return;
	const assumption = readAssumption(id) || st.assumption || "(no assumption)";
	updateState(id, { state: "killed" });
	if (st.founder) appendToGraveyard({ founder: st.founder, id, assumption, reason: "stale — no state change in 14+ days; answered by inattention (I4)" });

	const { channelId } = require("./config");
	const graveyard = channelId("graveyard");
	if (graveyard) {
		await client.chat.postMessage({ channel: graveyard, text: `\`${id}\` killed — stale (no movement in 14+ days)${st.channel_id ? ` (was <#${st.channel_id}>)` : ""}` }).catch(() => {});
	}
	if (st.channel_id) {
		await client.conversations.archive({ channel: st.channel_id }).catch((e) => {
			console.error(`staleness: archive failed for ${id}: ${e?.data?.error || e.message}`);
			if (graveyard) client.chat.postMessage({ channel: graveyard, text: `⚠️ couldn't archive <#${st.channel_id}> for stale-killed \`${id}\` — archive by hand.` }).catch(() => {});
		});
	}
	const { commitAndPush } = require("./git");
	await commitAndPush([`ideas/${id}`], `idea ${id}: killed (stale) via I4 nudge`, (e) => console.error(`staleness kill commit failed: ${e}`));
	emit(buildEvalEvent({ stage: "audit", ideaId: id, founder: st.founder, verdict: "kill", status: "ok", reasonCode: "stale" }));
}

function startStalenessSweep(client, onError) {
	let lastRunDate = null;
	const tick = () => {
		const today = new Date().toISOString().slice(0, 10);
		if (lastRunDate === today) return;
		lastRunDate = today;
		sweepStaleIdeas(client)
			.then((r) => console.log(`staleness: swept ${r.checked} idea(s), nudged ${r.nudged}`))
			.catch((e) => onError?.(String(e?.message || e)));
	};
	const t = setInterval(tick, CHECK_INTERVAL_MS);
	if (t.unref) t.unref();
	tick(); // once at startup
	return t;
}

module.exports = { startStalenessSweep, sweepStaleIdeas, killStale, pendingNudge, NUDGE_DAYS };
