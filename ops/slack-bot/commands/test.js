"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { founderForUserId, channelId } = require("../config");
const { callFlash } = require("../llm");
const { ideaExists, readState, readAssumption, updateState, IDEAS_DIR, nowIso } = require("../ideas");
const { commitAndPush } = require("../git");
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");
const { waitForThreadReply } = require("../thread-wait");

const MODEL = "flash"; // research keeps thinking_level: medium (D-08 amendment), mill-research key
const STAGE = "test";

// docs/COMMANDS.md: "Waits up to 30 minutes." Overridable for tests --
// nobody should have to actually wait 30 minutes to verify the timeout
// path fires correctly.
const FIELD_EVIDENCE_TIMEOUT_MS = Number(process.env.MILL_TEST_FIELD_TIMEOUT_MS) || 30 * 60 * 1000;

const FIELD_PROMPT = [
	"Before I research this: have you spoken to anyone about it?",
	"Paste anything you've heard — quotes, objections, prices people named, who they were.",
	"Reply `none` if you haven't.",
].join("\n");

function timestamp() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// Phase 1 (docs/COMMANDS.md): post the field-evidence question as the
// thread root, wait for the founder's reply in-thread. A non-"none"
// reply is field evidence; "none", or no reply inside the timeout,
// proceeds web-only. Returns evidence_basis is NOT decided here --
// Phase 2 combines this with whatever web evidence exists (currently
// none, see runPhase2) to land on the final basis.
async function runFieldEvidencePhase({ client, researchChannel, founderUserId, id }) {
	const posted = await client.chat.postMessage({
		channel: researchChannel,
		text: FIELD_PROMPT,
	});
	const threadTs = posted.ts;

	// waitForThreadReply matches against Slack's message.user, which is
	// always the raw Slack user id -- never the mapped founder name
	// (config.js's founderForUserId output). Passing the name here was a
	// real bug caught in testing: it made every reply silently fail to
	// match, so /test always hit the 30-minute timeout regardless of
	// whether the founder actually replied.
	const { replied, text } = await waitForThreadReply(
		threadTs,
		founderUserId,
		FIELD_EVIDENCE_TIMEOUT_MS,
	);

	let fieldNotesFile = null;
	let hasFieldEvidence = false;

	if (replied && text && text.toLowerCase() !== "none") {
		const fieldDir = path.join(IDEAS_DIR, id, "field");
		fs.mkdirSync(fieldDir, { recursive: true });
		const fname = `notes-${timestamp()}.md`;
		fs.writeFileSync(path.join(fieldDir, fname), `${text}\n`, "utf8");
		fieldNotesFile = `field/${fname}`;
		hasFieldEvidence = true;
	}

	return { threadTs, hasFieldEvidence, fieldNotesFile, timedOut: !replied };
}

// Phase 2 (docs/COMMANDS.md): "Runs ops/research.py (Part 11)." Part 11
// isn't built yet (GPT Researcher + search-provider integration is real
// infrastructure this build hasn't reached). Rather than fabricate web
// evidence or citations to look complete, this stub is explicit about
// what it didn't do: no web search ran, no sources were retrieved, no
// claim is made about the market -- D-20 ("no claim without a retrieved
// source") means the honest move here is to assert nothing, not to
// generate plausible-sounding filler. The one real model call this
// makes is the gap-output question generation, which asks questions
// rather than asserting facts, so it doesn't carry the same risk.
async function runResearchPass({ id, assumption, hasFieldEvidence, fieldNotesFile, threadTs }) {
	const evidenceBasis = hasFieldEvidence ? "field-supported" : "web-only";
	let gapOutput = null;
	let tokensIn = 0;
	let tokensOut = 0;
	let wallClockS = 0;

	if (evidenceBasis === "web-only") {
		const messages = [
			{
				role: "system",
				content:
					"Given a business assumption with no evidence gathered yet, output exactly three specific questions that would resolve whether it's true, and for each question name the kind of person who could answer it. Do not answer the questions yourself. Do not assert anything about the market.",
			},
			{ role: "user", content: assumption },
		];
		const t0 = Date.now();
		const { content, usage } = await callFlash(messages, { model: MODEL, maxTokens: 2048 });
		wallClockS += (Date.now() - t0) / 1000;
		tokensIn += usage?.prompt_tokens ?? 0;
		tokensOut += usage?.completion_tokens ?? 0;
		gapOutput = content;
	}

	const stamp = timestamp();
	const ts = nowIso();

	const reportMd = [
		`# Research — ${id}`,
		"",
		`**Assumption:** ${assumption}`,
		`**Evidence basis:** ${evidenceBasis}`,
		"**Research stub:** true — no web research ran; /audit will not rule on this report as-is.",
		`**Generated:** ${ts}`,
		"",
		"## Field evidence",
		"",
		hasFieldEvidence
			? `See \`${fieldNotesFile}\`.`
			: "None — founder replied `none` or did not reply within the field-evidence window.",
		"",
		"## Web evidence",
		"",
		"**Not yet available.** Part 11 (GPT Researcher integration) is not built in this deployment. No web search ran and no sources were retrieved for this report — per D-20, nothing is asserted here without a retrieved source, so this section deliberately makes no claims rather than fabricating any.",
		"",
		...(gapOutput
			? ["## Gap output", "", gapOutput, ""]
			: []),
	].join("\n");

	const reportJson = {
		id,
		assumption,
		evidence_basis: evidenceBasis,
		sources: [],
		field_notes_file: fieldNotesFile,
		web_research_status: "not_yet_built",
		// Unmissable, not just documented in prose: Part 11 (GPT
		// Researcher) isn't built, so no web research actually ran.
		// /audit checks this flag in code and refuses to rule when it's
		// set -- a stub silently producing a kill or narrow verdict is
		// worse than an explicit "no research has run" error.
		research_stub: true,
		// So /audit can post its verdict "in the research thread" per
		// docs/COMMANDS.md, without re-deriving or guessing which
		// message started it.
		slack_thread_ts: threadTs,
		ts,
	};

	const dir = path.join(IDEAS_DIR, id);
	fs.writeFileSync(path.join(dir, `research-${stamp}.md`), `${reportMd}\n`, "utf8");
	fs.writeFileSync(
		path.join(dir, `research-${stamp}.json`),
		`${JSON.stringify(reportJson, null, 2)}\n`,
		"utf8",
	);

	return { evidenceBasis, reportMd, stamp, tokensIn, tokensOut, wallClockS };
}

async function handleTestCommand({ command, ack, client }) {
	const founder = founderForUserId(command.user_id);
	if (!founder) {
		await ack(); // D-40: off-allowlist -> silent
		return;
	}

	const id = (command.text || "").trim();
	if (!id) {
		await ack({
			response_type: "ephemeral",
			text: "`/test` needs an idea id: `/test <id>`",
		});
		return;
	}

	if (!ideaExists(id)) {
		await ack({
			response_type: "ephemeral",
			text: `\`/test\` can't find idea \`${id}\`. Use the id \`/attack\` gave you.`,
		});
		return;
	}

	await ack();

	const researchChannel = channelId("research");
	if (!researchChannel) {
		console.error("SLACK_CHANNEL_RESEARCH not configured — /test cannot post anywhere");
		return;
	}

	try {
		const assumption = readAssumption(id);
		if (!assumption) {
			await client.chat.postMessage({
				channel: researchChannel,
				text: `\`/test\` failed for idea \`${id}\`: no assumption found in idea.md.`,
			});
			return;
		}

		const { threadTs, hasFieldEvidence, fieldNotesFile, timedOut } = await runFieldEvidencePhase({
			client,
			researchChannel,
			founderUserId: command.user_id,
			id,
		});

		const { evidenceBasis, reportMd, tokensIn, tokensOut, wallClockS } = await runResearchPass({
			id,
			assumption,
			hasFieldEvidence,
			fieldNotesFile,
			threadTs,
		});

		updateState(id, { state: "researched" });

		await commitAndPush(
			[`ideas/${id}`],
			`idea ${id}: research pass (${evidenceBasis}) via /test by ${founder}`,
			(reason) => console.error(`git commit/push failed for idea ${id} research: ${reason}`),
		);

		emit(
			buildEvalEvent({
				stage: STAGE,
				model: hasFieldEvidence ? null : MODEL,
				founder,
				ideaId: id,
				tokensIn,
				tokensOut,
				wallClockS,
				evidenceBasis,
				status: "ok",
				reasonCode: timedOut ? "field_evidence_timeout" : null,
			}),
		);

		await client.chat.postMessage({
			channel: researchChannel,
			thread_ts: threadTs,
			text: `Research pass complete for \`${id}\` — evidence basis: *${evidenceBasis}*.\n\n${reportMd}\n\nThis report is a stub (no web research ran) — \`/audit ${id}\` will refuse to rule on it until Part 11's research pipeline is built.`,
		});
	} catch (err) {
		console.error("test command failed:", err);
		emit(
			buildEvalEvent({
				stage: STAGE,
				founder,
				ideaId: id,
				status: "failed",
				reasonCode: "research_pass_failed",
			}),
		);
		await client.chat
			.postMessage({
				channel: researchChannel,
				text: `\`/test\` failed for idea \`${id}\`: ${err?.message || err}`,
			})
			.catch(() => {});
	}
}

module.exports = { handleTestCommand, runFieldEvidencePhase, runResearchPass, FIELD_EVIDENCE_TIMEOUT_MS };
