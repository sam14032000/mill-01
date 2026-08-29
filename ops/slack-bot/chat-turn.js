"use strict";

// Conversational turn handling for #chats threads and project stage
// threads (build-guide-projects 14.2/14.3, 16.3). Called from index.js's
// message router before the DM-capture path. Returns true if the message
// was consumed.
//
// ROOT CAUSE A (first real use): the conversational layer and the
// command layer both answered the same request -- "attack this idea"
// produced a prose attack AND an offer to run the real /attack, neither
// authoritative. Fixed by branching *before* the conversational model
// runs:
//
//   regex intent, valid          -> execute the command, no prose reply
//   model says high-confidence   -> execute the command, discard prose
//   model says medium-confidence -> prose reply + a one-tap offer
//   low / none                   -> prose reply only
//
// The conversational model is also told (PROMPT_TRAILER_INSTRUCTION) not
// to perform a command's job in prose. "Reply + offer for the same
// action" is now structurally impossible.
//
// Bug 1: every path posts an immediate placeholder and updates it in
// place, so the founder is never staring at nothing.

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
const { dispatchCommand } = require("./command-shim");

const MODEL = "flash-fast";
const STAGE = "chat";
const OFFER_TTL_MIN = Math.round((Number(process.env.MILL_OFFER_TTL_MS) || 2 * 60 * 60 * 1000) / 60000);

// The state a suggested action is validated against before it's executed
// or offered (the risk: /audit before research, /proto on a killed idea).
function buildValidationCtx(session, isProject) {
	const ideaId = session.ideaId || null;
	return {
		inChats: !isProject,
		project: isProject && ideaId ? readState(ideaId) : null,
		assumption: isProject && ideaId ? readAssumption(ideaId) : null,
		research: isProject && ideaId ? readLatestResearch(ideaId) : null,
	};
}

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
	const stageName = isProject ? "project_turn" : STAGE;
	const ideaId = session.ideaId || null;
	const ctx = buildValidationCtx(session, isProject);
	const triggerTurnIndex = session.turns.length - 1;

	const post = (text, extra = {}) =>
		client.chat.postMessage({ channel: message.channel, thread_ts: session.threadTs, text, ...extra });
	const update = (ts, text, extra = {}) =>
		client.chat.update({ channel: message.channel, ts, text, ...extra }).catch(() => {});

	// Runs the real command handler via the shim. The command owns the
	// response from here -- no prose reply, no offer, no prose turn.
	const execute = async (action, source, { discardedReply = null, placeholderTs = null } = {}) => {
		if (placeholderTs) await update(placeholderTs, `_On it — running \`/${action}\`…_`);
		else await post(`_On it — running \`/${action}\`…_`);
		try {
			await dispatchCommand({
				action,
				text, // the shim rebuilds the subject / resolves anaphora from the thread
				channelId: message.channel,
				userId: message.user,
				threadTs: session.threadTs,
				client,
			});
		} catch (err) {
			console.error(`chat-turn: execute ${action} failed (${session.threadTs}): ${err.message}`);
			await post(`_\`/${action}\` didn't run: ${err?.message || err}_`);
		}
		emit(
			buildEvalEvent({
				stage: stageName,
				model: MODEL,
				founder: session.ownerFounder,
				ideaId,
				status: "ok",
				reasonCode: `executed_${source}`,
				suggestedAction: null,
				suggestionConfidence: null,
				regexAction: source === "regex" ? action : null,
				offerMade: false,
				offerAction: null,
				offerSuppressedReason: null,
				executedAction: action,
				executionSource: source,
				discardedReply: Boolean(discardedReply),
			}),
		);
	};

	// ---- 1. regex fast path: execute directly, no conversational call ----
	const regexHit = detectRegexIntent(text);
	let regexSuppressed = null;
	if (regexHit) {
		const v = validateSuggestion(regexHit.action, ctx);
		if (v.ok) {
			await execute(regexHit.action, "regex");
			return true;
		}
		// Regex matched but the action doesn't apply yet (e.g. "audit this"
		// before research). Fall through to a conversational reply that can
		// explain why; record the reason.
		regexSuppressed = v.reason;
	}

	// ---- 2. the one conversational model call ----
	const placeholderTs = await post("_Thinking…_").then((r) => r.ts).catch(() => null);

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
		emit(buildEvalEvent({ stage: stageName, model: MODEL, founder: session.ownerFounder, status: "failed", reasonCode: "model_call_failed" }));
		const msg = `_(couldn't generate a reply: ${err?.message || err})_`;
		if (placeholderTs) await update(placeholderTs, msg);
		else await post(msg);
		return true;
	}
	const wallClockS = (Date.now() - t0) / 1000;

	const { reply: replyText, suggested_action, confidence } = splitReplyTrailer(raw);

	// ---- 3. high-confidence model intent: execute, discard the prose ----
	if (!regexSuppressed && confidence === "high" && suggested_action) {
		const v = validateSuggestion(suggested_action, ctx);
		if (v.ok) {
			await execute(suggested_action, "model_high", { discardedReply: replyText, placeholderTs });
			// The discarded prose is NOT recorded as a turn.
			try {
				await maybeCompact(session);
			} catch (err) {
				console.error(`chat-turn: compaction failed (${session.threadTs}): ${err.message}`);
			}
			return true;
		}
	}

	// ---- 4. genuine conversation: prose reply, offer only on medium ----
	let offer = null;
	let offerSuppressed = regexSuppressed;
	if (confidence === "medium" && suggested_action) {
		const v = validateSuggestion(suggested_action, ctx);
		if (v.ok) {
			offer = {
				action: suggested_action,
				confidence: "medium",
				offeredAt: Date.now(),
				ideaId,
				turnIndex: triggerTurnIndex,
			};
		} else {
			offerSuppressed = offerSuppressed || v.reason;
		}
	}
	// low / null confidence -> no offer (the stated bar).

	// Only the trailer-stripped prose is a turn.
	addTurn(session, { role: "assistant", text: replyText });

	const blocks = buildReplyBlocks(replyText, {
		promote: !isProject,
		offer,
		threadTs: session.threadTs,
		ttlMin: OFFER_TTL_MIN,
	});
	if (placeholderTs) await update(placeholderTs, replyText, { blocks });
	else await post(replyText, { blocks });

	try {
		const marker = await maybeCompact(session);
		if (marker) await post(marker);
	} catch (err) {
		console.error(`chat-turn: compaction failed (${session.threadTs}): ${err.message}`);
	}

	emit(
		buildEvalEvent({
			stage: stageName,
			model: MODEL,
			founder: session.ownerFounder,
			ideaId,
			tokensIn: usage?.prompt_tokens ?? 0,
			tokensOut: usage?.completion_tokens ?? 0,
			costUsd,
			cacheHitRatio: cacheHit ? 1 : 0,
			wallClockS,
			status: "ok",
			reasonCode: session.stage ? `stage_${session.stage}` : "turn",
			// D-51 telemetry -- every turn, nulls included. suggestion_confidence
			// + offer_made + (on a later tap) an offer_tap event let EVAL see
			// whether mediums get tapped, i.e. whether the bar is right.
			suggestedAction: suggested_action,
			suggestionConfidence: confidence,
			regexAction: regexHit ? regexHit.action : null,
			offerMade: Boolean(offer),
			offerAction: offer ? offer.action : null,
			offerSuppressedReason: offerSuppressed,
			executedAction: null,
			executionSource: null,
			discardedReply: false,
		}),
	);
	return true;
}

module.exports = { handleChatTurn };
