"use strict";

// Promotion: chat -> project (docs/PROJECTS.md "Promotion", build-guide-
// projects Part 15). A chat is disposable; promotion is the explicit act
// that makes it durable. Retroactive, not prospective -- promoting a
// 40-turn chat must lose nothing, so origin-chat.md gets the FULL
// transcript, never the compacted view.

const { channelId } = require("./config");
const { callFlash } = require("./llm");
const { generateIdeaId, promoteIdea } = require("./ideas");
const { commitAndPush } = require("./git");
const { emit } = require("./telemetry");
const { buildEvalEvent } = require("./eval-event");
const { fullTranscript, markPromoted } = require("./chat-session");
const { PROMOTE_ACTION_ID, withPromoteButton, withPromoteButtonIfChat } = require("./promote-button");
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
// Splits a long turn on paragraph, then sentence, then hard boundaries --
// the same conservative strategy the Slack bridges use (D-39) and the one
// this bot's other message formatting follows.
function chunkForSlack(text, max) {
	if (text.length <= max) return [text];
	const out = [];
	let rest = text;
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n\n", max);
		if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
		if (cut < max * 0.5) cut = rest.lastIndexOf(". ", max);
		if (cut < max * 0.5) cut = max;
		out.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) out.push(rest);
	return out;
}

// `_idOverride` is a TEST HOOK, alongside the existing `_simulateFailure`.
// Without it a test that exercises this path calls generateIdeaId(), which
// mints a REAL 4-char id -- and promoteChat commits it, so verification
// runs pushed junk ideas into the shared repo (211b/32ec/3b33 got there
// exactly this way). git.js excludes `ideas/zz*` from every commit, so a
// test passing a zz id is committable-by-construction impossible.
async function promoteChat({ session, client, triggeredByUserId, _simulateFailure = false, _idOverride = null }) {
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

	const id = _idOverride || generateIdeaId();

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

	// The project's first CHAT. Its card is the chat's thread root
	// (chat-card.js), so the card and the conversation are the same thread
	// -- and the origin summary is posted as the first reply inside it,
	// not as a frozen header that goes stale the moment /attack runs.
	let chatTs = null;
	try {
		const { createChatCard } = require("./chat-card");
		const created = await createChatCard(client, id, { title: topic ? String(topic).slice(0, 60) : "Main", createdBy: founder });
		chatTs = created.chatTs;
	} catch (err) {
		console.error(`promotion: could not open the first chat for ${id}: ${err.message}`);
	}

	// TRANSFER the chat, turn by turn, into the project's first chat
	// thread. Slack cannot move messages between channels, so "attach"
	// means replaying the conversation as it read in #chats -- each turn
	// its own message, in order, attributed -- rather than collapsing it
	// into a summary. The founder scrolls the project thread and sees the
	// conversation they actually had; origin-chat.md remains the verbatim
	// record either way.
	let seedPost = null;
	if (chatTs) {
		seedPost = await client.chat
			.postMessage({
				channel: project.channelId,
				thread_ts: chatTs,
				text:
					`_Transferred from a chat by ${founder} — ${session.turns.length} turn${session.turns.length === 1 ? "" : "s"}, replayed below. ` +
					`Verbatim transcript at \`ideas/${id}/origin-chat.md\`._`,
			})
			.catch((err) => {
				console.error(`promotion: transfer header failed: ${err?.data?.error || err.message}`);
				return null;
			});

		let replayed = 0;
		for (const turn of session.turns) {
			const body = String(turn.text || "").trim();
			if (!body) continue;
			const who = turn.role === "user" ? founder : "Mill";
			// Slack caps a message at 4000 chars; chunk on paragraph
			// boundaries so a long turn stays readable instead of truncated.
			for (const piece of chunkForSlack(body, 3600)) {
				await client.chat
					.postMessage({ channel: project.channelId, thread_ts: chatTs, text: `*${who}:*\n${piece}` })
					.catch((err) => console.error(`promotion: replay failed at turn ${replayed}: ${err?.data?.error || err.message}`));
				// chat.postMessage is ~1/sec per channel; pace so a long
				// transcript doesn't get rate-limited midway.
				await new Promise((r) => setTimeout(r, 350));
			}
			replayed += 1;
		}
		console.log(`promotion: transferred ${replayed} turn(s) into ${id}`);
	}

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
			text:
				`✅ Transferred to <#${project.channelId}> (\`${id}\`) — every turn replayed there, transcript saved. ` +
				// Slash commands don't work in threads (D-51), so never tell a
				// founder to run one there.
				`${assumption ? "The assumption from `/attack` carried over." : "Set an assumption with `@Mill attack` in the project."}`,
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
		// Only reached from #chats today, but routed through the guard so it
		// stays correct if that ever changes.
		msg.blocks = withPromoteButtonIfChat(text, threadTs, channel);
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
