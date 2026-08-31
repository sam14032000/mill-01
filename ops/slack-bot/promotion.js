"use strict";

// Promotion: chat -> project (docs/PROJECTS.md "Promotion", build-guide-
// projects Part 15). A chat is disposable; promotion is the explicit act
// that makes it durable. Retroactive, not prospective -- promoting a
// 40-turn chat must lose nothing, so origin-chat.md gets the FULL
// transcript, never the compacted view.

const { channelId } = require("./config");
const { callFlash } = require("./llm");
const { generateIdeaId, promoteIdea, updateState } = require("./ideas");
const { commitAndPush } = require("./git");
const { emit } = require("./telemetry");
const { buildEvalEvent } = require("./eval-event");
const { fullTranscript, markPromoted } = require("./chat-session");
const { PROMOTE_ACTION_ID, withPromoteButton } = require("./promote-button");
const { createProjectChannel } = require("./project-channel");
const { upsertStateCard } = require("./state-card");

// Pull the assumption out of a chat: the last /attack the founder ran in
// this session posted "*Assumption:* ..." as an assistant turn (see
// commands/attack.js's chat branch). Fall back to a bare "ASSUMPTION:"
// line anywhere in the transcript.
function extractAssumption(session) {
	for (let i = session.turns.length - 1; i >= 0; i--) {
		const t = session.turns[i];
		if (t.role !== "assistant") continue;
		let m = t.text.match(/\*Assumption:\*\s*(.+?)(?:\n|$)/);
		if (m) return m[1].trim();
		m = t.text.match(/ASSUMPTION:\s*(.+?)(?:\n|$)/);
		if (m) return m[1].trim();
	}
	return null;
}

// If /attack ran in the chat and returned TOO_VAGUE instead of an
// assumption, that feedback -- the specifics needed before the idea can
// be attacked -- must survive promotion, not be lost in the transition
// (Bug 1). Most recent TOO_VAGUE line wins.
function extractTooVague(session) {
	for (let i = session.turns.length - 1; i >= 0; i--) {
		const t = session.turns[i];
		if (t.role !== "assistant") continue;
		const m = t.text.match(/TOO_VAGUE:\s*(.+?)(?:\n\n|\n_|$)/s);
		if (m) return m[1].trim().replace(/\s+/g, " ");
	}
	return null;
}

async function summarizeChat(session) {
	const transcript = fullTranscript(session);
	try {
		const { content } = await callFlash(
			[
				{
					role: "system",
					content:
						"Summarise this chat for the Brainstorm thread of a new project. " +
						"What is the idea, who it serves, what has to be true, and where the founder got to. " +
						"Preserve every assumption, number, and named alternative. 150 words max, plain prose.",
				},
				{ role: "user", content: transcript },
			],
			{ model: "flash-fast", maxTokens: 1024 },
		);
		return (content || "").trim() || "(summary unavailable)";
	} catch (err) {
		console.error(`promotion: summary call failed: ${err.message}`);
		return "(summary unavailable — model call failed)";
	}
}

// build-guide-projects 15.3. `_simulateFailure` is a test seam for the
// "failed channel creation creates no idea at all" verification -- it
// throws at the point Part 16's channel creation will sit, before any
// idea directory is written.
async function promoteChat({ session, client, triggeredByUserId, _simulateFailure = false }) {
	const chatsChannel = session.channel;
	const millChannel = channelId("mill");

	if (session.promoted) {
		await client.chat
			.postMessage({
				channel: chatsChannel,
				thread_ts: session.threadTs,
				text: "_This chat has already been promoted to a project._",
			})
			.catch(() => {});
		return { ok: false, reason: "already_promoted" };
	}

	const founder = session.ownerFounder;
	const topic = session.topic;

	// --- everything fallible happens BEFORE anything is written to disk ---
	// (PROJECTS.md failure table: "Channel creation fails during promotion
	// -> Do not create the idea. A half-promoted idea is worse than none.")
	const transcript = fullTranscript(session);
	const assumption = extractAssumption(session);
	const tooVagueDetail = assumption ? null : extractTooVague(session);
	const summary = await summarizeChat(session);

	const id = generateIdeaId();

	let project;
	try {
		if (_simulateFailure) throw new Error("simulated project-channel creation failure");
		project = await createProjectChannel({
			id,
			sourceText: assumption || topic,
			assumption,
			client,
		});
	} catch (err) {
		console.error(`promotion: project channel creation failed for ${id}: ${err?.data?.error || err.message}`);
		await client.chat
			.postMessage({
				channel: chatsChannel,
				thread_ts: session.threadTs,
				text: `_Couldn't create the project channel (${err?.data?.error || err.message}). Nothing was created — your chat is untouched. Try promoting again._`,
			})
			.catch(() => {});
		return { ok: false, reason: "channel_creation_failed" };
	}

	try {
		promoteIdea({
			id,
			founder,
			topic,
			assumption,
			tooVagueDetail,
			originChatMd: transcript,
			originChatTs: session.threadTs,
			summary,
			channelId: project.channelId,
			threads: project.threads,
		});
	} catch (err) {
		console.error(`promotion: promoteIdea failed for ${id}: ${err.message}`);
		await client.chat
			.postMessage({
				channel: chatsChannel,
				thread_ts: session.threadTs,
				text: `_Couldn't finish promoting: ${err.message}. The project channel <#${project.channelId}> exists but the idea record didn't write — tell someone._`,
			})
			.catch(() => {});
		return { ok: false, reason: "promote_idea_failed", channelId: project.channelId };
	}

	// mode_banner_ts: which button row is currently live, so the first
	// mode switch retires it instead of leaving a stale row (D-54).
	if (project.bannerTs) updateState(id, { mode_banner_ts: project.bannerTs });

	await commitAndPush(
		[`ideas/${id}`],
		`idea ${id}: promoted from chat by ${founder}`,
		(reason) => console.error(`git commit/push failed for promoted idea ${id}: ${reason}`),
	);

	markPromoted(session.threadTs);

	const assumptionLine = assumption
		? `*Assumption:* ${assumption}`
		: tooVagueDetail
			? `*No assumption yet.* \`/attack\` in the chat flagged this as too vague to attack — it needs: ${tooVagueDetail}\nPin those down in Brainstorm, then run \`/attack\`.`
			: "_No assumption yet — run `/attack` in Brainstorm, then `/test`._";

	// 15.3 step 4: seed the Brainstorm thread with the origin-chat summary
	// and a link back to the chat.
	const seedPost = await client.chat
		.postMessage({
			channel: project.channelId,
			thread_ts: project.threads.project,
			text:
				`*Seeded from a chat by ${founder}.*\n\n${summary}\n\n${assumptionLine}\n\n` +
				`Full origin chat: <https://slack.com/app_redirect?channel=${session.channel}&message_ts=${session.threadTs}|jump to the thread> · transcript at \`ideas/${id}/origin-chat.md\` (all ${session.turns.length} turns).`,
		})
		.catch((err) => {
			console.error(`promotion: brainstorm seed failed: ${err?.data?.error || err.message}`);
			return null;
		});

	// D-52 follow-up: create the pinned current-state card for the new
	// project channel. upsertStateCard commits its own state.json write
	// (state_card_ts), since the promotion commit above ran before the
	// channel existed.
	await upsertStateCard(client, id, { latestTs: seedPost?.ts, latestChannel: project.channelId });

	// 15.3 step 5: announce in #mill-ideas and link the new channel.
	if (millChannel) {
		await client.chat
			.postMessage({
				channel: millChannel,
				text: `*New project* <#${project.channelId}> \`${id}\` — promoted from a chat by ${founder}. ${assumptionLine}`,
			})
			.catch((err) => console.error(`promotion: #mill-ideas post failed: ${err.message}`));
	}

	await client.chat
		.postMessage({
			channel: chatsChannel,
			thread_ts: session.threadTs,
			text: `✅ Promoted to <#${project.channelId}> (\`${id}\`). Full transcript saved. ${assumption ? "The `/attack` assumption carried over." : "Run `/attack` then `/test` in the project."}`,
		})
		.catch(() => {});

	emit(
		buildEvalEvent({
			stage: "promotion",
			model: null,
			founder,
			ideaId: id,
			status: "ok",
			reasonCode: assumption ? "with_assumption" : "no_assumption",
		}),
	);

	return { ok: true, id, assumption, channelId: project.channelId, threads: project.threads };
}

// 15.2: /test, /proto, /audit run from #chats hit a chat's ceiling.
// Never silently refuse, never silently run -- say what's needed and
// offer the button.
async function postNeedsProject({ client, channel, threadTs, what }) {
	const text = `${what}\nThat needs a project. Start one from this chat and everything stays together.`;
	const msg = { channel, text };
	if (threadTs) {
		msg.thread_ts = threadTs;
		msg.blocks = withPromoteButton(text, threadTs);
	}
	await client.chat.postMessage(msg).catch(() => {});
}

module.exports = {
	PROMOTE_ACTION_ID,
	withPromoteButton,
	extractAssumption,
	summarizeChat,
	promoteChat,
	postNeedsProject,
};
