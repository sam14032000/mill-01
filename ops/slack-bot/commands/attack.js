"use strict";

const { founderForUserId, channelId } = require("../config");
const { callFlash } = require("../llm");
const { generateIdeaId, createIdea } = require("../ideas");
const { commitAndPush } = require("../git");
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");
const { readProfile } = require("../context");

const MODEL = "flash-fast";
const STAGE = "attack";

// Verbatim from docs/COMMANDS.md's /attack system prompt.
const SYSTEM_PROMPT = [
	"Make the strongest case against this idea. Not balanced — the prosecution.",
	"Then output the single assumption that, if false, kills it.",
	'It must be falsifiable: something evidence could refute. "Users want this" is not falsifiable. "Users currently pay >$50/mo for a worse alternative" is.',
	"The assumption must contain a number — a price, a percentage, or a count — and must name the specific alternative it's being displaced from. An assumption without both is not falsifiable enough to research.",
	"Return the assumption alone on the final line, prefixed `ASSUMPTION:`.",
	"If the idea doesn't name a specific customer, mechanism, or context precisely enough to attack, do not invent them. Instead return a single line, prefixed `TOO_VAGUE:`, naming the two or three specifics that would be needed before this could be attacked.",
].join("\n");

// Requires the assumption (or refusal) on the model's actual final
// non-empty line -- deliberately does not scan the whole body for a
// stray match, since that would accept a sloppier response than the
// prompt asked for. Returns one of:
//   { kind: "assumption", assumption, caseText }
//   { kind: "too_vague", detail }
//   null (neither found -- triggers the one retry in runAttack)
function parseAttackResponse(responseText) {
	const lines = responseText.trim().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;

		const vague = line.match(/^TOO_VAGUE:\s*(.+)$/i);
		if (vague) return { kind: "too_vague", detail: vague[1].trim() };

		const assumption = line.match(/^ASSUMPTION:\s*(.+)$/i);
		if (assumption) {
			return {
				kind: "assumption",
				assumption: assumption[1].trim(),
				caseText: lines.slice(0, i).join("\n").trim(),
			};
		}

		return null;
	}
	return null;
}

// One retry on a missing ASSUMPTION line, then give up -- per
// docs/COMMANDS.md ("Retry once, then report failure. No idea created.").
// Interactive command -> flash-fast (thinking_level: low, D-08
// amendment). max_tokens raised to 4096: thinking tokens are drawn from
// the same output budget, and a low value can leave nothing for the
// visible answer even at low thinking level.
//
// tokensIn/tokensOut/wallClockS accumulate across both attempts if a
// retry happens, so telemetry (and cost) reflect everything actually
// spent on this invocation, not just the last call.
async function runAttack({ founder, ideaText }) {
	const profile = readProfile(founder);
	const messages = [
		{ role: "system", content: SYSTEM_PROMPT },
		{
			role: "system",
			content: `Founder profile (how they fail):\n\n${profile || "(no profile recorded yet)"}`,
		},
		{ role: "user", content: ideaText },
	];

	let responseText = "";
	let parsed = null;
	let tokensIn = 0;
	let tokensOut = 0;
	let costUsd = 0;
	let wallClockS = 0;

	for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
		const t0 = Date.now();
		const { content, usage, costUsd: callCost } = await callFlash(messages, {
			model: MODEL,
			maxTokens: 4096,
		});
		wallClockS += (Date.now() - t0) / 1000;
		tokensIn += usage?.prompt_tokens ?? 0;
		tokensOut += usage?.completion_tokens ?? 0;
		costUsd += callCost ?? 0;

		responseText = content;
		parsed = parseAttackResponse(responseText);
	}

	return { responseText, tokensIn, tokensOut, costUsd, wallClockS, parsed };
}

async function handleAttackCommand({ command, ack, client }) {
	const founder = founderForUserId(command.user_id);
	if (!founder) {
		await ack(); // D-40: off-allowlist -> silent
		return;
	}

	const ideaText = (command.text || "").trim();
	if (!ideaText) {
		await ack({
			response_type: "ephemeral",
			text: "`/attack` needs the idea text: `/attack <idea>`",
		});
		return;
	}

	// Ack within Slack's 3s window; the model call runs async and posts
	// its result to #mill-ideas directly via the Web API.
	await ack();

	const millChannel = channelId("mill");
	if (!millChannel) {
		console.error(
			"SLACK_CHANNEL_MILL not configured — /attack cannot post its result anywhere",
		);
	}

	try {
		const { tokensIn, tokensOut, costUsd, wallClockS, parsed } = await runAttack({ founder, ideaText });

		if (!parsed) {
			emit(
				buildEvalEvent({
					stage: STAGE,
					model: MODEL,
					founder,
					tokensIn,
					tokensOut,
					costUsd,
					wallClockS,
					status: "failed",
					reasonCode: "no_assumption_or_too_vague_line",
				}),
			);
			if (millChannel) {
				await client.chat.postMessage({
					channel: millChannel,
					text: `\`/attack\` failed for ${founder}: the model didn't return a falsifiable assumption after one retry. No idea created.`,
				});
			}
			return;
		}

		if (parsed.kind === "too_vague") {
			// Refusal path: no retry (the model already returned a
			// definite answer on this attempt), no idea created. Post
			// the line as-is per docs/COMMANDS.md.
			emit(
				buildEvalEvent({
					stage: STAGE,
					model: MODEL,
					founder,
					tokensIn,
					tokensOut,
					costUsd,
					wallClockS,
					status: "refused",
					reasonCode: "too_vague",
				}),
			);
			if (millChannel) {
				await client.chat.postMessage({
					channel: millChannel,
					text: `TOO_VAGUE: ${parsed.detail}`,
				});
			}
			return;
		}

		const id = generateIdeaId();
		createIdea({
			id,
			founder,
			originText: ideaText,
			caseText: parsed.caseText,
			assumption: parsed.assumption,
		});

		await commitAndPush(
			[`ideas/${id}`],
			`idea ${id}: created via /attack by ${founder}`,
			(reason) => console.error(`git commit/push failed for idea ${id}: ${reason}`),
		);

		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder,
				ideaId: id,
				tokensIn,
				tokensOut,
				costUsd,
				wallClockS,
				status: "ok",
			}),
		);

		if (millChannel) {
			await client.chat.postMessage({
				channel: millChannel,
				text: `${parsed.caseText}\n\n*Assumption:* ${parsed.assumption}\n\nCreated \`${id}\` — \`/test ${id}\` to research it`,
			});
		}
	} catch (err) {
		console.error("attack command failed:", err);
		// tokensIn/tokensOut/wallClockS aren't available here -- the
		// exception can come from inside callFlash before it returns
		// usage. 0 is the honest default: we don't know what the
		// provider actually billed on a failed call, and can't invent a
		// number for it.
		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder,
				tokensIn: 0,
				tokensOut: 0,
				costUsd: 0,
				wallClockS: 0,
				status: "failed",
				reasonCode: "model_call_failed",
			}),
		);
		if (millChannel) {
			await client.chat
				.postMessage({
					channel: millChannel,
					text: `\`/attack\` failed for ${founder}: ${err?.message || err}`,
				})
				.catch(() => {});
		}
	}
}

module.exports = { handleAttackCommand, parseAttackResponse, runAttack };
