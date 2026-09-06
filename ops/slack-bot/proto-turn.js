"use strict";

// A message in proto mode, once the session is bootstrapped.
//
// It is a CHANGE REQUEST, not conversation, so it goes to the plan/build
// loop rather than the generic agent loop — which has no idea a prototype
// is open and would answer in prose about a project it cannot see.
//
// A founder always lands in plan mode (D-58): plan-first is the default,
// the mode returns to it after every build, and "just build" applies only
// while it is explicitly set. Code never changes without the founder
// having read what would change, unless they turned that off themselves.

const { readState } = require("./ideas");
const protoFlow = require("./proto-flow");
const { withDeadline, DeadlineError } = require("./deadline");

const TOUCH_CAP = 5;

// The refusal is D-29's, verbatim — the wording is the point, not the
// mechanism: wanting to keep iterating past five is the signal that the
// founders have decided to build.
const TOUCH_CAP_TEXT =
	"Touch cap reached. Either this assumption was answered three touches ago, or you've decided to build this — which is a different conversation with a different budget.";

async function handleProtoMessage({ session, message, client, text }) {
	const id = session.ideaId;
	const chatTs = session.threadTs;
	const channel = message.channel;
	const state = readState(id) || {};

	if (state.state === "killed") {
		await client.chat
			.postMessage({ channel, thread_ts: chatTs, text: `\`${id}\` is killed. That verdict doesn't get worked around with a prototype.` })
			.catch(() => {});
		return true;
	}
	if ((state.touch_count ?? 0) >= TOUCH_CAP) {
		await client.chat.postMessage({ channel, thread_ts: chatTs, text: TOUCH_CAP_TEXT }).catch(() => {});
		return true;
	}

	const st = protoFlow.protoState(id, chatTs);
	const progress = await client.chat
		.postMessage({ channel, thread_ts: chatTs, text: st.planFirst ? "_Planning…_" : "_Building…_" })
		.catch(() => null);
	const progressTs = progress?.ts || null;

	const say = async (t, blocks) => {
		if (progressTs) await client.chat.update({ channel, ts: progressTs, text: t, ...(blocks ? { blocks } : { blocks: [] }) }).catch(() => {});
		else await client.chat.postMessage({ channel, thread_ts: chatTs, text: t, ...(blocks ? { blocks } : {}) }).catch(() => {});
	};

	// "Just build" skips the approval gate. It still plans internally --
	// the agent needs to decide what to do -- but nothing waits on a tap.
	if (!st.planFirst) {
		const built = await runBounded(() => protoFlow.buildApproved({ id, chatTs, request: text }), "build");
		await reportBuild({ client, channel, chatTs, id, res: built, say });
		return true;
	}

	const res = await runBounded(() => protoFlow.planChange({ id, chatTs, request: text }), "plan");
	if (!res.ok) {
		await say(
			res.missing
				? "The coding agent isn't available on this box right now, so I can't plan a change. The build log and files are untouched."
				: `Couldn't plan that: ${res.reason}`,
		);
		return true;
	}
	protoFlow.setProto(id, chatTs, { proto_pending_plan: { at: Date.now(), sessionId: res.sessionId } });
	const rendered = protoFlow.planBlocks(id, chatTs, res.plan);
	const refreshed = res.refreshedFrom?.length
		? `_Brought the session up to date on the ${res.refreshedFrom.map((m) => protoFlow.DOC_LABEL[m]).join(" and ")} first._\n\n`
		: "";
	await say(`${refreshed}${rendered.text}`, rendered.blocks);
	return true;
}

// Every model-driven step is bounded, so a stalled agent becomes a
// visible failure rather than a founder watching a placeholder.
async function runBounded(fn, label) {
	const ms = Number(process.env.MILL_PROTO_DEADLINE_MS) || 600_000;
	// Deliberately a little longer than the engine's own deadline, so the
	// engine reports its specific failure first and this only catches the
	// case where the engine itself never returns. Configurable so the
	// margin is testable rather than a magic 30s.
	const margin = Number(process.env.MILL_PROTO_DEADLINE_MARGIN_MS) || 30_000;
	try {
		return await withDeadline(fn(), ms + margin, `proto ${label}`);
	} catch (err) {
		if (err instanceof DeadlineError) return { ok: false, reason: `the ${label} stalled and I stopped waiting on it` };
		return { ok: false, reason: err.message };
	}
}

// Shared with the [Build it] button path so the two cannot drift: what is
// reported is read off the TREE, not off what the plan forecast.
async function reportBuild({ client, channel, chatTs, id, res, say }) {
	if (!res.ok) {
		await say(`The build didn't land: ${res.reason}`);
		return;
	}
	const { updateState } = require("./ideas");
	updateState(id, { state: "prototyping", touch_count: res.touchN });

	const lines = [];
	if (res.changedFiles.length) lines.push(`*Changed:* ${res.changedFiles.map((f) => `\`${f}\``).join(", ")}`);
	if (res.removedFiles.length) lines.push(`*Removed:* ${res.removedFiles.map((f) => `\`${f}\``).join(", ")}`);
	if (!res.changedFiles.length && !res.removedFiles.length) lines.push("_No files changed._");
	if (res.untouched.length) lines.push(`_${res.untouched.length} other file${res.untouched.length === 1 ? "" : "s"} untouched._`);
	if (res.cost) lines.push(`_Built for $${Number(res.cost).toFixed(3)}._`);
	const touchNote = res.touchN >= TOUCH_CAP ? `\n\n_That was touch ${TOUCH_CAP} — the next one will be refused._` : `\n\n_Touch ${res.touchN}/${TOUCH_CAP}._`;
	await say(`🔨 *Built.*\n${lines.join("\n")}${touchNote}`);

	const { commitAndPush } = require("./git");
	await commitAndPush([`ideas/${id}/proto/${res.touchN}`], `idea ${id}: proto touch ${res.touchN}`, (r) =>
		console.error(`proto: commit failed: ${r}`),
	).catch(() => {});
}

module.exports = { handleProtoMessage, reportBuild, TOUCH_CAP, TOUCH_CAP_TEXT };
