"use strict";

const { founderForUserId, channelId } = require("../config");
const { callFlash } = require("../llm");
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");
const { readCaptures } = require("../context");
const { commandDestination, postCommandResult } = require("../chat-session");

const MODEL = "flash-fast";
const STAGE = "themes";

// Verbatim from docs/COMMANDS.md's /themes system prompt.
const SYSTEM_PROMPT = [
	"What has this founder circled back to repeatedly? Name recurring preoccupations, not a summary.",
	"Flag anything returned to more than twice without ever becoming an idea — that is a signal worth surfacing.",
].join("\n");

// Context per docs/COMMANDS.md: last 30 days of that founder's captures
// -- uncapped by entry count, unlike the other commands' "last 20"
// window, since the whole point is spotting a pattern across a month.
async function runThemes({ founder }) {
	const captures = readCaptures(founder, { maxDays: 30 });

	const messages = [
		{ role: "system", content: SYSTEM_PROMPT },
		{
			role: "user",
			content: captures.length
				? `Captures from the last 30 days:\n\n${captures.join("\n")}`
				: "(no captures in the last 30 days)",
		},
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

async function handleThemesCommand({ command, ack, client }) {
	const founder = founderForUserId(command.user_id);
	if (!founder) {
		await ack(); // D-40: off-allowlist -> silent
		return;
	}

	await ack();

	const dest = commandDestination(command);
	if (!dest.channel) {
		console.error("/themes has no channel to post to (mill/chats unset)");
	}

	try {
		const { responseText, tokensIn, tokensOut, costUsd, cacheHitRatio, wallClockS } = await runThemes({ founder });

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
				invocation: "/themes",
				userId: command.user_id,
			});
		}
	} catch (err) {
		console.error("themes command failed:", err);
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
					text: `\`/themes\` failed for ${founder}: ${err?.message || err}`,
				})
				.catch(() => {});
		}
	}
}

module.exports = { handleThemesCommand, runThemes };
