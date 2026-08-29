"use strict";

const { founderForUserId, channelId } = require("../config");
const { callFlash } = require("../llm");
const { generateIdeaId, createIdea, setAssumption } = require("../ideas");
const { commitAndPush } = require("../git");
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");
const { readProfile } = require("../context");
const { findLatestSessionForUser, addTurn, commandDestination, ensureStageThread } = require("../chat-session");
const { withPromoteButton } = require("../promote-button");
const { upsertStateCard } = require("../state-card");
const { composeIdeaInput } = require("../intent");
const { postResult } = require("../reply");

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
async function runAttack({ founder, ideaText, threadContext = "" }) {
	const profile = readProfile(founder);
	// ROOT CAUSE B: invoked from a thread, the idea is the conversation --
	// "let's start by attacking it" is a pointer into it, not the idea.
	const userContent = composeIdeaInput(ideaText, threadContext);
	const messages = [
		{ role: "system", content: SYSTEM_PROMPT },
		{
			role: "system",
			content: `Founder profile (how they fail):\n\n${profile || "(no profile recorded yet)"}`,
		},
		{ role: "user", content: userContent },
	];

	let responseText = "";
	let parsed = null;
	let tokensIn = 0;
	let tokensOut = 0;
	let costUsd = 0;
	let calls = 0;
	let cacheHits = 0;
	let wallClockS = 0;

	for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
		const t0 = Date.now();
		const { content, usage, costUsd: callCost, cacheHit } = await callFlash(messages, {
			model: MODEL,
			maxTokens: 4096,
		});
		wallClockS += (Date.now() - t0) / 1000;
		tokensIn += usage?.prompt_tokens ?? 0;
		tokensOut += usage?.completion_tokens ?? 0;
		costUsd += callCost ?? 0;
		calls += 1;
		if (cacheHit) cacheHits += 1;

		responseText = content;
		parsed = parseAttackResponse(responseText);
	}

	return {
		responseText,
		tokensIn,
		tokensOut,
		costUsd,
		cacheHitRatio: calls ? cacheHits / calls : 0,
		wallClockS,
		parsed,
	};
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
	const chatsChannel = channelId("chats");

	// build-guide-projects 14.4 / PROJECTS.md: `/attack` in a chat writes
	// NOTHING -- no idea, no state.json, no directory. It returns the case
	// + ASSUMPTION line into the chat thread; promotion (Part 15) is what
	// turns that assumption into a project.
	const inChat = command.channel_id === chatsChannel;
	const chatSess = inChat ? findLatestSessionForUser(command.user_id, chatsChannel) : null;
	const dest = inChat ? chatsChannel : millChannel;
	const threadTs = chatSess ? chatSess.threadTs : undefined;
	const postToDest = (text) => {
		if (!dest) {
			console.error("/attack has no channel to post to (mill/chats unset)");
			return Promise.resolve();
		}
		const msg = { channel: dest, text };
		if (threadTs) {
			msg.thread_ts = threadTs;
			msg.blocks = withPromoteButton(text, threadTs); // 15.1
		}
		return postResult(client, msg);
	};

	if (!millChannel && !inChat) {
		console.error(
			"SLACK_CHANNEL_MILL not configured — /attack cannot post its result anywhere",
		);
	}

	try {
		const { tokensIn, tokensOut, costUsd, cacheHitRatio, wallClockS, parsed } = await runAttack({
			founder,
			ideaText,
			threadContext: command.thread_context || "",
		});

		if (inChat) {
			// Chat mode: post the result, record it in the session so
			// compaction and promotion keep it, create nothing on disk.
			let out;
			if (!parsed) {
				out = "`/attack` couldn't produce a falsifiable assumption after one retry.";
			} else if (parsed.kind === "too_vague") {
				out = `TOO_VAGUE: ${parsed.detail}`;
			} else {
				out = `${parsed.caseText}\n\n*Assumption:* ${parsed.assumption}\n\n_Promote this chat to a project to research it (\`/test\` needs a project)._`;
			}
			await postToDest(out);
			if (chatSess) {
				addTurn(chatSess, { role: "user", text: `/attack ${ideaText}`, userId: command.user_id, kind: "command" });
				addTurn(chatSess, { role: "assistant", text: out, kind: "command" });
			}
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
					status: parsed && parsed.kind !== "too_vague" ? "ok" : parsed ? "refused" : "failed",
					reasonCode: "chat_no_idea",
				}),
			);
			return;
		}

		// Project channel (16.3): post to the Brainstorm thread. The idea
		// already exists -- don't create another. If it has no assumption
		// yet (promotion didn't carry one), this sets it.
		const pdest = commandDestination(command);
		if (pdest.project) {
			await ensureStageThread(client, pdest);
			let out;
			if (!parsed) {
				out = "`/attack` couldn't produce a falsifiable assumption after one retry.";
			} else if (parsed.kind === "too_vague") {
				out = `TOO_VAGUE: ${parsed.detail}`;
			} else {
				const already = pdest.project.has_assumption;
				if (!already) setAssumption(pdest.project.id, parsed.assumption);
				out =
					`${parsed.caseText}\n\n*Assumption:* ${parsed.assumption}\n\n` +
					(already
						? "_This project already has an assumption on file; not overwriting it._"
						: `_Set as the assumption for \`${pdest.project.id}\`. \`/test\` in the Research thread next._`);
				if (!already) {
					await commitAndPush(
						[`ideas/${pdest.project.id}`],
						`idea ${pdest.project.id}: assumption set via /attack by ${founder}`,
						(reason) => console.error(`git commit/push failed for ${pdest.project.id}: ${reason}`),
					);
				}
			}
			const posted = await postResult(client, { channel: pdest.channel, thread_ts: pdest.threadTs, text: out });
			// D-52: refresh the pinned state card (assumption may now be set).
			await upsertStateCard(client, pdest.project.id, { latestTs: posted?.ts, latestChannel: pdest.channel });
			emit(
				buildEvalEvent({
					stage: STAGE,
					model: MODEL,
					founder,
					ideaId: pdest.project.id,
					tokensIn,
					tokensOut,
					costUsd,
					cacheHitRatio,
					wallClockS,
					status: parsed && parsed.kind !== "too_vague" ? "ok" : parsed ? "refused" : "failed",
					reasonCode: "project_attack",
				}),
			);
			return;
		}

		if (!parsed) {
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
					cacheHitRatio,
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
				cacheHitRatio,
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
