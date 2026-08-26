"use strict";

const { founderForUserId, channelId } = require("../config");
const { callFlash } = require("../llm");
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");
const { readProfile, readCaptures, hasProfile } = require("../context");

const MODEL = "flash-fast";
const STAGE = "think";

// Verbatim from docs/COMMANDS.md's /think system prompt.
const SYSTEM_PROMPT = [
	"Develop this idea concretely — mechanism, who it serves, what has to be true.",
	"Then attack it from the angle this founder's profile says they would miss.",
	"The attack matters more than the development. Do not soften it.",
	"End with the single weakest point, stated in one sentence.",
].join("\n");

// Same prompt with the profile-informed-attack instruction removed, for
// when there is no profile to read an angle from -- see below.
const SYSTEM_PROMPT_NO_PROFILE = [
	"Develop this idea concretely — mechanism, who it serves, what has to be true.",
	"Then attack it as sharply as you can. Do not soften it.",
	"End with the single weakest point, stated in one sentence.",
].join("\n");

// Context per docs/COMMANDS.md: [1][2][4] -- system prompt, founder
// profile, last 20 captures (or ~8000 tokens, whichever is smaller).
//
// Guarded against fabrication from an empty profile (context.js's
// hasProfile): the prompt explicitly asks for "the angle this founder's
// profile says they would miss," and measured behavior on /cross shows
// the model does not refuse that instruction when there's no profile to
// draw on -- it invents a plausible-sounding angle and presents it as
// profile-informed. With no profile, this swaps in a prompt that never
// asks for that framing, and the reply is prefixed so the founder knows
// what they're getting isn't personalized.
async function runThink({ founder, ideaText }) {
	const profile = readProfile(founder);
	const hasRealProfile = hasProfile(founder);
	const captures = readCaptures(founder, { maxEntries: 20, maxTokens: 8000 });

	const messages = [
		{ role: "system", content: hasRealProfile ? SYSTEM_PROMPT : SYSTEM_PROMPT_NO_PROFILE },
		{
			role: "system",
			content: hasRealProfile
				? `Founder profile (how they fail):\n\n${profile}`
				: "(no profile recorded yet)",
		},
		{
			role: "system",
			content: captures.length
				? `Recent captures from this founder:\n\n${captures.join("\n")}`
				: "(no recent captures)",
		},
		{ role: "user", content: ideaText },
	];

	const t0 = Date.now();
	const { content, usage } = await callFlash(messages, { model: MODEL, maxTokens: 4096 });
	const wallClockS = (Date.now() - t0) / 1000;

	const responseText = hasRealProfile
		? content
		: `_(no profile recorded yet for ${founder} — generic attack, not informed by known failure patterns)_\n\n${content}`;

	return {
		responseText,
		tokensIn: usage?.prompt_tokens ?? 0,
		tokensOut: usage?.completion_tokens ?? 0,
		wallClockS,
	};
}

async function handleThinkCommand({ command, ack, client }) {
	const founder = founderForUserId(command.user_id);
	if (!founder) {
		await ack(); // D-40: off-allowlist -> silent
		return;
	}

	const ideaText = (command.text || "").trim();
	if (!ideaText) {
		await ack({
			response_type: "ephemeral",
			text: "`/think` needs the idea text: `/think <idea>`",
		});
		return;
	}

	await ack();

	const millChannel = channelId("mill");
	if (!millChannel) {
		console.error("SLACK_CHANNEL_MILL not configured — /think cannot post its result anywhere");
	}

	try {
		const { responseText, tokensIn, tokensOut, wallClockS } = await runThink({
			founder,
			ideaText,
		});

		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder,
				tokensIn,
				tokensOut,
				wallClockS,
				status: "ok",
			}),
		);

		if (millChannel) {
			await client.chat.postMessage({ channel: millChannel, text: responseText });
		}
	} catch (err) {
		console.error("think command failed:", err);
		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder,
				status: "failed",
				reasonCode: "model_call_failed",
			}),
		);
		if (millChannel) {
			await client.chat
				.postMessage({
					channel: millChannel,
					text: `\`/think\` failed for ${founder}: ${err?.message || err}`,
				})
				.catch(() => {});
		}
	}
}

module.exports = { handleThinkCommand, runThink };
