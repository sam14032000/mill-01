"use strict";

const { founderForUserId, channelId } = require("../config");
const { callFlash } = require("../llm");
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");
const { readDynamics } = require("../context");
const { commandDestination, postCommandResult } = require("../chat-session");
const { composeIdeaInput } = require("../intent");

const MODEL = "flash-fast";
const STAGE = "blindspot";

// Verbatim from docs/COMMANDS.md's /blindspot system prompt.
const SYSTEM_PROMPT = [
	"Attack from the shared blind spot described below. All three founders would miss this.",
	"Agreement among three founders is not validation; it usually means shared priors.",
	"Name what none of them would think to check.",
].join("\n");

// Context per docs/COMMANDS.md: [1][3] -- system prompt, shared/dynamics.md.
// Deliberately no individual profile (D-27: this is about all three).
async function runBlindspot({ ideaText, threadContext = "" }) {
	const dynamics = readDynamics();

	const messages = [
		{ role: "system", content: SYSTEM_PROMPT },
		{
			role: "system",
			content: `Shared blind spots (where all three founders converge too fast):\n\n${dynamics || "(no shared blind spots recorded yet)"}`,
		},
		{ role: "user", content: composeIdeaInput(ideaText, threadContext) },
	];

	const t0 = Date.now();
	const { content, usage, costUsd, cacheHit } = await callFlash(messages, { model: MODEL, maxTokens: 4096 });
	const wallClockS = (Date.now() - t0) / 1000;

	return {
		responseText: content,
		tokensIn: usage?.prompt_tokens ?? 0,
		tokensOut: usage?.completion_tokens ?? 0,
		costUsd,
		cacheHitRatio: cacheHit ? 1 : 0,
		wallClockS,
	};
}

async function handleBlindspotCommand({ command, ack, client }) {
	const founder = founderForUserId(command.user_id);
	if (!founder) {
		await ack(); // D-40: off-allowlist -> silent
		return;
	}

	const ideaText = (command.text || "").trim();
	if (!ideaText) {
		await ack({
			response_type: "ephemeral",
			text: "`/blindspot` needs the idea text: `/blindspot <idea>`",
		});
		return;
	}

	await ack();

	const dest = commandDestination(command);
	if (!dest.channel) {
		console.error("/blindspot has no channel to post to (mill/chats unset)");
	}

	try {
		const { responseText, tokensIn, tokensOut, costUsd, cacheHitRatio, wallClockS } = await runBlindspot({
			ideaText,
			threadContext: command.thread_context || "",
		});

		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder,
				tokensIn,
				tokensOut,
				costUsd,
				cacheHitRatio,
				wallClockS,
				status: "ok",
			}),
		);

		if (dest.channel) {
			await postCommandResult(client, dest, {
				text: responseText,
				invocation: `/blindspot ${ideaText}`,
				userId: command.user_id,
			});
		}
	} catch (err) {
		console.error("blindspot command failed:", err);
		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder,
				status: "failed",
				reasonCode: "model_call_failed",
			}),
		);
		if (dest.channel) {
			await client.chat
				.postMessage({
					channel: dest.channel,
					...(dest.threadTs ? { thread_ts: dest.threadTs } : {}),
					text: `\`/blindspot\` failed for ${founder}: ${err?.message || err}`,
				})
				.catch(() => {});
		}
	}
}

module.exports = { handleBlindspotCommand, runBlindspot };
