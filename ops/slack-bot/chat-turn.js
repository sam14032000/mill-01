"use strict";

// Conversational turn handling for #chats threads and project stage
// threads (build-guide-projects 14.2/14.3, 16.3). Called from index.js's
// message router before the DM-capture path. Returns true if the message
// was consumed.
//
// D-51: slash commands don't work in Slack threads. This handler already
// sees every conversational turn, so it also (a) reads a structured
// action-suggestion trailer off the same reply call it's already making,
// (b) runs a fast regex for unambiguous phrasing, and (c) appends a
// one-tap offer to the reply when an intent is detected AND applies to
// the idea's current state. The offer never interrupts: it's appended to
// the normal reply, ignoring it costs nothing.

const { founderForUserId, channelId } = require("./config");
const { callFlash } = require("./llm");
const { emit } = require("./telemetry");
const { buildEvalEvent } = require("./eval-event");
const {
	getSession,
	getOrCreateStageSession,
	addTurn,
	buildContextMessages,
	maybeCompact,
} = require("./chat-session");
const { buildReplyBlocks } = require("./promote-button");
const {
	findIdeaByChannel,
	readState,
	readAssumption,
	readLatestResearch,
} = require("./ideas");
const {
	detectRegexIntent,
	validateSuggestion,
	splitReplyTrailer,
	PROMPT_TRAILER_INSTRUCTION,
} = require("./intent");

const MODEL = "flash-fast";
const STAGE = "chat";
const OFFER_TTL_MIN = Math.round((Number(process.env.MILL_OFFER_TTL_MS) || 2 * 60 * 60 * 1000) / 60000);

async function handleChatTurn({ message, client }) {
	if (message.bot_id) return false;
	if (!message.thread_ts) return false;

	const inChats = message.channel === channelId("chats");
	const project = inChats ? null : findIdeaByChannel(message.channel);
	if (!inChats && !project) return false;

	const speakerFounder = message.user ? founderForUserId(message.user) : null;

	const session = inChats
		? getSession(message.thread_ts)
		: getOrCreateStageSession({
				project,
				threadTs: message.thread_ts,
				channel: message.channel,
				speakerUserId: message.user,
				speakerFounder,
			});
	if (!session) return false;

	if (inChats && (message.subtype === "file_share" || (message.files && message.files.length))) {
		const text = "I can't store files in a chat — start a project and I'll keep it with the idea.";
		await client.chat
			.postMessage({ channel: message.channel, thread_ts: session.threadTs, text, blocks: buildReplyBlocks(text, { promote: true, threadTs: session.threadTs }) })
			.catch(() => {});
		return true;
	}

	if (message.subtype) return false;
	if (!message.user || !message.text) return false;

	const speaker = founderForUserId(message.user);
	if (!speaker) return true;

	const text = message.text.trim();
	if (!text) return true;

	addTurn(session, { role: "user", text, userId: message.user, ts: message.ts });

	const isProject = session.kind === "project";

	// --- the one model call, with the action-suggestion trailer asked for ---
	const messages = buildContextMessages(session);
	messages.splice(1, 0, { role: "system", content: PROMPT_TRAILER_INSTRUCTION });

	let raw;
	let usage;
	let costUsd = 0;
	let cacheHit = false;
	const t0 = Date.now();
	try {
		const res = await callFlash(messages, { model: MODEL, maxTokens: 4096 });
		raw = res.content;
		usage = res.usage;
		costUsd = res.costUsd;
		cacheHit = res.cacheHit;
	} catch (err) {
		console.error(`chat-turn: model call failed (${session.threadTs}): ${err.message}`);
		emit(buildEvalEvent({ stage: isProject ? "project_turn" : STAGE, model: MODEL, founder: session.ownerFounder, status: "failed", reasonCode: "model_call_failed" }));
		await client.chat
			.postMessage({ channel: message.channel, thread_ts: session.threadTs, text: `_(couldn't generate a reply: ${err?.message || err})_` })
			.catch(() => {});
		return true;
	}
	const wallClockS = (Date.now() - t0) / 1000;

	const { reply: replyText, suggested_action, confidence } = splitReplyTrailer(raw);

	// --- intent: regex fast path wins; else a high-confidence model suggestion ---
	const regexHit = detectRegexIntent(text);
	const intent =
		regexHit ||
		(confidence === "high" && suggested_action ? { action: suggested_action, source: "model" } : null);

	// --- validate against actual idea state before offering (the risk:
	//     /audit before research, /proto on a killed idea) ---
	let offer = null;
	let offerSuppressed = null;
	if (intent) {
		const ideaId = session.ideaId || null;
		const ctx = {
			inChats: !isProject,
			project: isProject && ideaId ? readState(ideaId) : null,
			assumption: isProject && ideaId ? readAssumption(ideaId) : null,
			research: isProject && ideaId ? readLatestResearch(ideaId) : null,
		};
		const v = validateSuggestion(intent.action, ctx);
		if (v.ok) offer = { action: intent.action, offeredAt: Date.now(), ideaId, turnIndex: session.turns.length - 1 };
		else offerSuppressed = v.reason;
	}

	// A5: only replyText (trailer-stripped, no offer chrome) is a turn.
	addTurn(session, { role: "assistant", text: replyText });

	await client.chat.postMessage({
		channel: message.channel,
		thread_ts: session.threadTs,
		text: replyText,
		blocks: buildReplyBlocks(replyText, {
			promote: !isProject, // PROJECTS.md P2: promote button on every #chats reply
			offer,
			threadTs: session.threadTs,
			ttlMin: OFFER_TTL_MIN,
		}),
	});

	try {
		const marker = await maybeCompact(session);
		if (marker) {
			await client.chat.postMessage({ channel: message.channel, thread_ts: session.threadTs, text: marker });
		}
	} catch (err) {
		console.error(`chat-turn: compaction failed (${session.threadTs}): ${err.message}`);
	}

	emit(
		buildEvalEvent({
			stage: isProject ? "project_turn" : STAGE,
			model: MODEL,
			founder: session.ownerFounder,
			ideaId: session.ideaId || null,
			tokensIn: usage?.prompt_tokens ?? 0,
			tokensOut: usage?.completion_tokens ?? 0,
			costUsd,
			cacheHitRatio: cacheHit ? 1 : 0,
			wallClockS,
			status: "ok",
			reasonCode: session.stage ? `stage_${session.stage}` : "turn",
			// D-51 telemetry -- logged every turn, nulls included, so an
			// over-eager prompt (offers on >~1/5 of turns) shows here.
			suggestedAction: suggested_action, // model's raw suggestion (may be non-null at low confidence)
			suggestionConfidence: confidence, // model's confidence
			regexAction: regexHit ? regexHit.action : null,
			offerMade: Boolean(offer),
			offerAction: offer ? offer.action : null,
			offerSuppressedReason: offerSuppressed,
		}),
	);
	return true;
}

module.exports = { handleChatTurn };
