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
const { PROMOTE_ACTION_ID, withPromoteButton } = require("./promote-button");

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
	const transcript = fullTranscript(session);
	const assumption = extractAssumption(session);
	const summary = await summarizeChat(session);

	// Part 16 will create the project channel here. Until then, flat
	// structure (15.3 step 3). The test seam simulates that step failing.
	if (_simulateFailure) {
		throw new Error("simulated project-channel creation failure");
	}

	const id = generateIdeaId();

	try {
		promoteIdea({
			id,
			founder,
			topic,
			assumption,
			originChatMd: transcript,
			originChatTs: session.threadTs,
			summary,
		});
	} catch (err) {
		// Nothing partial: promoteIdea writes all three files or the dir
		// simply isn't usable. Report and bail without marking promoted.
		console.error(`promotion: promoteIdea failed for ${id}: ${err.message}`);
		await client.chat
			.postMessage({
				channel: chatsChannel,
				thread_ts: session.threadTs,
				text: `_Couldn't promote this chat: ${err.message}. Nothing was created; try again._`,
			})
			.catch(() => {});
		return { ok: false, reason: "promote_idea_failed" };
	}

	await commitAndPush(
		[`ideas/${id}`],
		`idea ${id}: promoted from chat by ${founder}`,
		(reason) => console.error(`git commit/push failed for promoted idea ${id}: ${reason}`),
	);

	markPromoted(session.threadTs);

	const assumptionLine = assumption
		? `*Assumption:* ${assumption}`
		: "_No assumption yet — run `/attack` then `/test` in the project._";

	// 15.3 step 4/5: seed + announce. Project channel + Brainstorm thread
	// arrive in Part 16; for now the seed goes to #mill-ideas.
	if (millChannel) {
		await client.chat
			.postMessage({
				channel: millChannel,
				text:
					`*New project \`${id}\`* — ${topic || "(untitled)"}\n` +
					`_promoted from a chat by ${founder}_\n\n` +
					`${summary}\n\n${assumptionLine}\n\n` +
					`Origin chat transcript: \`ideas/${id}/origin-chat.md\` (all ${session.turns.length} turns).`,
			})
			.catch((err) => console.error(`promotion: #mill-ideas post failed: ${err.message}`));
	}

	await client.chat
		.postMessage({
			channel: chatsChannel,
			thread_ts: session.threadTs,
			text:
				`✅ Promoted to project \`${id}\`. The full transcript is saved to \`ideas/${id}/origin-chat.md\`. ` +
				(assumption
					? "The assumption from `/attack` carried over."
					: "No assumption yet — `/attack` then `/test` inside the project.") +
				(millChannel ? " Announced in <#" + millChannel + ">." : ""),
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

	return { ok: true, id, assumption };
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
