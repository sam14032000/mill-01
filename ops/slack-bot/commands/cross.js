"use strict";

const { founderForUserId, channelId } = require("../config");
const { callFlash } = require("../llm");
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");
const { readProfile } = require("../context");

const MODEL = "flash-fast";
const STAGE = "cross";

// The three-founder roster is fixed (D-40's allowlist config already
// hardcodes these three names). /cross needs "the other two" given
// whoever sent the command.
const ALL_FOUNDERS = ["saksham", "amisha", "vaibhav"];

// Verbatim from docs/COMMANDS.md's /cross system prompt (per call).
const SYSTEM_PROMPT = [
	"You are reading this idea through the lens of a different founder's thinking patterns, given below. Attack it as they would.",
	"Do not moderate or balance. One perspective only.",
].join("\n");

function otherFounders(sender) {
	return ALL_FOUNDERS.filter((f) => f !== sender);
}

// Measured directly: with an empty profile, the model does not refuse
// or hedge -- it produces a full, confident, plausible-sounding "attack
// from this founder's angle" anyway (two such readings on the same idea
// came back independently near-duplicate, both reaching for the same
// generic objections). That's worse than no reading at all, because
// it's indistinguishable from a working /cross. A profile this short
// isn't "how this founder fails" (D-26) -- it's not describing anything
// yet, so there's nothing to read the idea through.
const MIN_PROFILE_LENGTH = 50;

// Context per docs/COMMANDS.md: [1] + each other founder's profile +
// the idea. Never the sender's own profile. Exactly two separate
// calls -- no third call computes convergence/divergence; that's for
// the founders reading both outputs to judge (runbook.md's "Reading
// /cross" guidance), not something fabricated by the model.
async function readAs(readerFounder, ideaText) {
	const profile = readProfile(readerFounder);

	if (profile.trim().length < MIN_PROFILE_LENGTH) {
		return {
			founder: readerFounder,
			responseText: `(${readerFounder}'s profile hasn't been recorded yet -- no reading generated from nothing.)`,
			skipped: true,
			tokensIn: 0,
			tokensOut: 0,
			wallClockS: 0,
		};
	}

	const messages = [
		{ role: "system", content: SYSTEM_PROMPT },
		{
			role: "system",
			content: `${readerFounder}'s profile (how they fail):\n\n${profile}`,
		},
		{ role: "user", content: ideaText },
	];

	const t0 = Date.now();
	const { content, usage } = await callFlash(messages, { model: MODEL, maxTokens: 4096 });
	const wallClockS = (Date.now() - t0) / 1000;

	return {
		founder: readerFounder,
		responseText: content,
		skipped: false,
		tokensIn: usage?.prompt_tokens ?? 0,
		tokensOut: usage?.completion_tokens ?? 0,
		wallClockS,
	};
}

async function runCross({ founder, ideaText }) {
	const [readerA, readerB] = otherFounders(founder);
	const [a, b] = await Promise.all([readAs(readerA, ideaText), readAs(readerB, ideaText)]);

	const parts = [
		`*Through ${a.founder}'s lens:*\n${a.responseText}`,
		`*Through ${b.founder}'s lens:*\n${b.responseText}`,
	];

	// The convergence/divergence question only means something if both
	// readings are real -- comparing two placeholders, or a real reading
	// against a placeholder, isn't a convergence/divergence signal.
	if (!a.skipped && !b.skipped) {
		parts.push(
			"Do these converge on the same objection, or diverge? Convergence means the objection is real; divergence means the idea carries multiple independent risks (D-27).",
		);
	}

	return {
		responseText: parts.join("\n\n"),
		tokensIn: a.tokensIn + b.tokensIn,
		tokensOut: a.tokensOut + b.tokensOut,
		wallClockS: a.wallClockS + b.wallClockS,
	};
}

async function handleCrossCommand({ command, ack, client }) {
	const founder = founderForUserId(command.user_id);
	if (!founder) {
		await ack(); // D-40: off-allowlist -> silent
		return;
	}

	const ideaText = (command.text || "").trim();
	if (!ideaText) {
		await ack({
			response_type: "ephemeral",
			text: "`/cross` needs the idea text: `/cross <idea>`",
		});
		return;
	}

	await ack();

	const millChannel = channelId("mill");
	if (!millChannel) {
		console.error("SLACK_CHANNEL_MILL not configured — /cross cannot post its result anywhere");
	}

	try {
		const { responseText, tokensIn, tokensOut, wallClockS } = await runCross({
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
		console.error("cross command failed:", err);
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
					text: `\`/cross\` failed for ${founder}: ${err?.message || err}`,
				})
				.catch(() => {});
		}
	}
}

module.exports = { handleCrossCommand, runCross, otherFounders };
