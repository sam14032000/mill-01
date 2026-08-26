"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { founderForUserId, channelId } = require("../config");
const { callFlash } = require("../llm");
const { generateIdeaId, createIdea } = require("../ideas");
const { commitAndPush } = require("../git");
const { emit } = require("../telemetry");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// Verbatim from docs/COMMANDS.md's /attack system prompt.
const SYSTEM_PROMPT = [
	"Make the strongest case against this idea. Not balanced — the prosecution.",
	"Then output the single assumption that, if false, kills it.",
	'It must be falsifiable: something evidence could refute. "Users want this" is not falsifiable. "Users currently pay >$50/mo for a worse alternative" is.',
	"The assumption must contain a number — a price, a percentage, or a count — and must name the specific alternative it's being displaced from. An assumption without both is not falsifiable enough to research.",
	"Return the assumption alone on the final line, prefixed `ASSUMPTION:`.",
	"If the idea doesn't name a specific customer, mechanism, or context precisely enough to attack, do not invent them. Instead return a single line, prefixed `TOO_VAGUE:`, naming the two or three specifics that would be needed before this could be attacked.",
].join("\n");

function readProfile(founder) {
	const p = path.join(REPO_ROOT, "minds", founder, "profile.md");
	try {
		return fs.readFileSync(p, "utf8");
	} catch {
		return "";
	}
}

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
	let usage;
	let parsed = null;
	for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
		({ content: responseText, usage } = await callFlash(messages, {
			model: "flash-fast",
			maxTokens: 4096,
		}));
		parsed = parseAttackResponse(responseText);
	}

	return { responseText, usage, parsed };
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
		const { usage, parsed } = await runAttack({ founder, ideaText });
		const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;

		if (!parsed) {
			emit({
				command: "attack",
				founder,
				status: "failed",
				reason: "no ASSUMPTION: or TOO_VAGUE: line after retry",
				reasoning_tokens: reasoningTokens,
			});
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
			emit({
				command: "attack",
				founder,
				status: "refused",
				reason: "too_vague",
				reasoning_tokens: reasoningTokens,
			});
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

		emit({
			command: "attack",
			founder,
			idea_id: id,
			status: "ok",
			reasoning_tokens: reasoningTokens,
		});

		if (millChannel) {
			await client.chat.postMessage({
				channel: millChannel,
				text: `${parsed.caseText}\n\n*Assumption:* ${parsed.assumption}\n\nCreated \`${id}\` — \`/test ${id}\` to research it`,
			});
		}
	} catch (err) {
		console.error("attack command failed:", err);
		emit({
			command: "attack",
			founder,
			status: "failed",
			reason: String(err?.message || err),
		});
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
