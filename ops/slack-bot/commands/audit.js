"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { founderForUserId, channelId } = require("../config");
const { callAudit } = require("../audit-llm");
const {
	ideaExists,
	readState,
	readAssumption,
	readLatestResearch,
	readFieldNotes,
	readOutcomes,
	readGraveyardDigest,
	updateState,
	IDEAS_DIR,
	nowIso,
} = require("../ideas");
const { commitAndPush } = require("../git");
const { commandDestination, ensureStageThread } = require("../chat-session");
const { postNeedsProject } = require("../promotion");
const { upsertStateCard } = require("../state-card");
const { postResult } = require("../reply");
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");

const MODEL = "audit"; // Fable 5. D-10: never called anywhere else in this codebase.
const STAGE = "audit";

// docs/COMMANDS.md's /audit system prompt + I1's evidence-grading rule.
const SYSTEM_PROMPT = [
	"Audit this assumption against the research provided. You are a gate, not an advisor.",
	"",
	"CLASSIFY the field evidence yourself from the raw founder notes in the report. Do NOT accept the founder's own characterisation of it. Grade it into `evidence_basis`:",
	"  • `none` — no research has run / no usable evidence",
	"  • `web-only` — published sources only, no field evidence",
	"  • `field-intent` — people said what they *would* do (would use, would pay, sounds useful). Surveys overestimate this; treat it as weak.",
	"  • `field-behaviour` — observed: what someone currently uses and pays, a real workaround (spreadsheet, WhatsApp group, a person they pay), or a price named/asked-for unprompted",
	"  • `field-committed` — someone paid, pre-ordered, signed up, or (in the prototype outcomes) actually did the thing",
	"",
	"`proceed` is only defensible on `field-behaviour` or `field-committed`. `web-only` and `field-intent` cap at `narrow` — published info and stated intent tell you a market might exist; they don't tell you anyone will buy.",
	"",
	"Previously killed ideas are listed below (I3). If this assumption is materially the same as one already killed, say so explicitly and weight the earlier kill reason — unless the research shows the reason no longer holds. Put the killed idea's id in `resembles_killed_idea`, else null.",
	"",
	"Be willing to kill. A kill returns founder attention, which is scarcer than money.",
	"Return only the JSON object specified. No preamble.",
].join("\n");

const REQUIRED_FIELDS = [
	"verdict",
	"evidence_basis",
	"load_bearing_assumption",
	"strongest_failure_reason",
	"what_would_change_verdict",
	"evidence_quality",
	"who_to_talk_to",
	"resembles_killed_idea", // I3: killed-idea id this assumption echoes, or null
];
const VALID_VERDICTS = ["proceed", "narrow", "kill"];
// I1: graded. Ordered weakest -> strongest.
const VALID_EVIDENCE_BASIS = ["none", "web-only", "field-intent", "field-behaviour", "field-committed"];
// The grades that can never carry a `proceed` (C-07, enforced in code).
const CAPPED_AT_NARROW = new Set(["none", "web-only", "field-intent"]);

// Models occasionally wrap JSON in a markdown code fence despite being
// told not to ("no preamble"). Stripped defensively before parsing;
// strict validation happens after, regardless of whether stripping was
// needed.
function stripCodeFence(text) {
	const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]+?)\s*```$/);
	return fenced ? fenced[1] : text;
}

// Parses and validates the model's response against the exact schema
// docs/COMMANDS.md specifies. Returns the parsed object or null if it's
// malformed in any way that should trigger a retry -- not just invalid
// JSON, but also missing fields or values outside the enum, since a
// verdict object missing "verdict" is exactly as useless as unparseable
// text.
function parseAuditResponse(text) {
	let obj;
	try {
		obj = JSON.parse(stripCodeFence(text));
	} catch {
		return null;
	}
	if (typeof obj !== "object" || obj === null) return null;
	for (const field of REQUIRED_FIELDS) {
		if (!(field in obj)) return null;
	}
	if (!VALID_VERDICTS.includes(obj.verdict)) return null;
	if (!VALID_EVIDENCE_BASIS.includes(obj.evidence_basis)) return null;
	// I3: resembles_killed_idea is a string id or null (not undefined --
	// "present in the object" is already checked via REQUIRED_FIELDS).
	if (obj.resembles_killed_idea !== null && typeof obj.resembles_killed_idea !== "string") return null;
	return obj;
}

// C-07, enforced here in code, never left to the prompt: a `proceed`
// verdict resting on web-only evidence is downgraded to `narrow`
// regardless of what the model returned. The prompt already asks for
// this ("proceed requires field evidence... caps at narrow"), but a
// prompt instruction is not enforcement -- this function is what
// actually guarantees a malformed or drifting audit prompt can never
// let a web-only proceed through. Returns the (possibly modified)
// verdict object and whether a downgrade happened.
function enforceEvidenceGate(verdictObj) {
	// I1: `proceed` requires field-behaviour or field-committed. Anything
	// weaker -- none, web-only, or field-intent ("they said they would")
	// -- is downgraded to `narrow` here in code regardless of what the
	// model returned.
	if (verdictObj.verdict === "proceed" && CAPPED_AT_NARROW.has(verdictObj.evidence_basis)) {
		return { verdict: { ...verdictObj, verdict: "narrow" }, downgraded: true };
	}
	return { verdict: verdictObj, downgraded: false };
}

function timestamp() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function appendToGraveyard({ founder, id, assumption, reason }) {
	const graveyardPath = path.join(IDEAS_DIR, "..", "minds", founder, "graveyard.md");
	const date = new Date().toISOString().slice(0, 10);
	const line = `- ${date} — \`${id}\`: ${assumption}\n  Reason: ${reason}\n`;
	fs.appendFileSync(graveyardPath, line, "utf8");
}

// Calls Fable 5 once; retries once more on a malformed response (bad
// JSON or missing/invalid fields), per docs/COMMANDS.md ("Malformed
// JSON -> one retry, then report failure. Never post an unvalidated
// verdict."). Context is deliberately narrow -- assumption plus the
// research report only, never idea.md's case-against text, never a
// profile, never brainstorm output (D-28).
//
// The schema below is not part of docs/COMMANDS.md's system prompt --
// that prompt is four lines of prose ending in "Return only the JSON
// object specified," and the schema itself is shown as a separate
// documentation block. Found live, not hypothetically: sending only the
// prose and no schema, Fable 5 (reasonably) invented its own field
// names (rationale, evidence_summary, what_would_change_this) instead
// of the ones parseAuditResponse actually validates against, and every
// attempt failed to parse. Built from the same REQUIRED_FIELDS/
// VALID_VERDICTS/VALID_EVIDENCE_BASIS constants the parser uses, so the
// instruction sent to the model and the validation applied to its
// response can't drift apart.
const SCHEMA_INSTRUCTION = `Return exactly one JSON object with these fields and no others:
{
  "verdict": one of ${JSON.stringify(VALID_VERDICTS)},
  "evidence_basis": one of ${JSON.stringify(VALID_EVIDENCE_BASIS)}  (you assign this by grading the raw field notes; ignore any label already in the report),
  "load_bearing_assumption": string,
  "strongest_failure_reason": string,
  "what_would_change_verdict": string,
  "evidence_quality": one of ["thin", "adequate", "strong"],
  "who_to_talk_to": string, required when evidence_basis is "none", "web-only" or "field-intent", otherwise null,
  "resembles_killed_idea": the id (string) of a previously-killed idea this assumption is materially the same as, otherwise null
}`;

async function runAudit({ assumption, researchMd, fieldNotesMd, outcomesMd, graveyardDigest }) {
	const parts = [`Assumption:\n${assumption}`, `Research report:\n${researchMd}`];
	// I1: the raw field notes, verbatim, for the model to grade itself.
	if (fieldNotesMd && fieldNotesMd.trim()) {
		parts.push(`Raw field notes (grade these — behaviour vs intent vs commitment):\n${fieldNotesMd}`);
	}
	// I2: what real people did when they saw the prototype. A recorded
	// signup / pre-order / payment here is what makes `field-committed`.
	if (outcomesMd && outcomesMd.trim()) {
		parts.push(`Prototype outcomes (real people seeing the built thing):\n${outcomesMd}`);
	}
	// I3: what has already been killed, and why.
	if (graveyardDigest && graveyardDigest.trim()) {
		parts.push(`Previously killed ideas (all founders):\n${graveyardDigest}`);
	}
	const messages = [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "system", content: SCHEMA_INSTRUCTION },
		{ role: "user", content: parts.join("\n\n") },
	];

	let parsed = null;
	let tokensIn = 0;
	let tokensOut = 0;
	let costUsd = 0;
	let calls = 0;
	let cacheHits = 0;
	let wallClockS = 0;

	for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
		const t0 = Date.now();
		const { content, usage, costUsd: callCost, cacheHit } = await callAudit(messages, { maxTokens: 4096 });
		wallClockS += (Date.now() - t0) / 1000;
		tokensIn += usage?.prompt_tokens ?? 0;
		tokensOut += usage?.completion_tokens ?? 0;
		costUsd += callCost ?? 0;
		calls += 1;
		if (cacheHit) cacheHits += 1;
		parsed = parseAuditResponse(content);
	}

	return { parsed, tokensIn, tokensOut, costUsd, cacheHitRatio: calls ? cacheHits / calls : 0, wallClockS };
}

async function handleAuditCommand({ command, ack, client }) {
	const invoker = founderForUserId(command.user_id);
	if (!invoker) {
		await ack(); // D-40: off-allowlist -> silent
		return;
	}

	// 15.2: the gate needs a project.
	if (command.channel_id === channelId("chats")) {
		await ack();
		const dest = commandDestination(command);
		await postNeedsProject({
			client,
			channel: dest.channel,
			threadTs: dest.threadTs,
			what: "`/audit` is the gate — it rules on a researched assumption.",
		});
		emit(buildEvalEvent({ stage: STAGE, founder: invoker, status: "refused", reasonCode: "needs_project" }));
		return;
	}

	// Project channel (16.3): id from the channel, verdict into the Audit
	// stage thread.
	const pdest = commandDestination(command);
	const id = pdest.project ? pdest.project.id : (command.text || "").trim();
	if (!id) {
		await ack({ response_type: "ephemeral", text: "`/audit` needs an idea id: `/audit <id>`" });
		return;
	}

	if (!ideaExists(id)) {
		await ack({
			response_type: "ephemeral",
			text: `\`/audit\` can't find idea \`${id}\`.`,
		});
		return;
	}

	await ack();

	const graveyardChannel = channelId("graveyard");
	let researchChannel;
	let auditThreadTs;
	if (pdest.project) {
		await ensureStageThread(client, pdest);
		researchChannel = pdest.channel;
		auditThreadTs = pdest.threadTs; // Audit stage thread
	} else {
		researchChannel = channelId("research");
		auditThreadTs = null; // set from research.json.slack_thread_ts below
	}
	if (!researchChannel) {
		console.error("SLACK_CHANNEL_RESEARCH not configured — /audit cannot post its result anywhere");
		return;
	}

	const research = readLatestResearch(id);
	const ideaState = readState(id);
	const ideaFounder = ideaState?.founder;

	// No research at all yet.
	if (!research) {
		await postResult(client, {
			channel: researchChannel,
			...(auditThreadTs ? { thread_ts: auditThreadTs } : {}),
			text: `\`/audit\` refuses to rule on \`${id}\`: no research has run. Use \`/test ${id}\` first.`,
		});
		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder: invoker,
				ideaId: id,
				status: "refused",
				reasonCode: "no_research",
			}),
		);
		return;
	}

	// research_stub missing is treated the same as research_stub: true --
	// every report in this deployment predates Part 11 (GPT Researcher),
	// so absence of the flag never means real research happened.
	if (research.json.research_stub !== false) {
		await postResult(client, {
			channel: researchChannel,
			thread_ts: auditThreadTs || research.json.slack_thread_ts,
			text: `\`/audit\` refuses to rule on \`${id}\`: no research has run — the report on file is a stub (Part 11's research pipeline isn't built). No verdict.`,
		});
		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder: invoker,
				ideaId: id,
				status: "refused",
				reasonCode: "research_stub",
			}),
		);
		return;
	}

	try {
		const assumption = readAssumption(id);
		const { parsed, tokensIn, tokensOut, costUsd, cacheHitRatio, wallClockS } = await runAudit({
			assumption,
			researchMd: research.md,
			fieldNotesMd: readFieldNotes(id),
			outcomesMd: readOutcomes(id),
			graveyardDigest: readGraveyardDigest(),
		});

		if (!parsed) {
			emit(
				buildEvalEvent({
					stage: STAGE,
					model: MODEL,
					founder: invoker,
					ideaId: id,
					tokensIn,
					tokensOut,
					costUsd,
					cacheHitRatio,
					wallClockS,
					status: "failed",
					reasonCode: "malformed_verdict_after_retry",
				}),
			);
			await postResult(client, {
				channel: researchChannel,
				thread_ts: auditThreadTs || research.json.slack_thread_ts,
				text: `\`/audit\` failed for \`${id}\`: the model didn't return a valid verdict after one retry. No verdict posted.`,
			});
			return;
		}

		const { verdict, downgraded } = enforceEvidenceGate(parsed);

		const stamp = timestamp();
		fs.writeFileSync(
			path.join(IDEAS_DIR, id, `audit-${stamp}.json`),
			`${JSON.stringify(verdict, null, 2)}\n`,
			"utf8",
		);

		if (verdict.verdict === "kill") {
			updateState(id, { state: "killed" });
			if (ideaFounder) {
				appendToGraveyard({
					founder: ideaFounder,
					id,
					assumption,
					reason: verdict.strongest_failure_reason,
				});
			}
		} else {
			updateState(id, { state: "audited" });
		}

		await commitAndPush(
			[`ideas/${id}`, ideaFounder ? `minds/${ideaFounder}/graveyard.md` : null].filter(Boolean),
			`idea ${id}: audit verdict ${verdict.verdict} (${verdict.evidence_basis})`,
			(reason) => console.error(`git commit/push failed for idea ${id} audit: ${reason}`),
		);

		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder: invoker,
				ideaId: id,
				tokensIn,
				tokensOut,
				costUsd,
				cacheHitRatio,
				wallClockS,
				verdict: verdict.verdict,
				evidenceBasis: verdict.evidence_basis,
				status: "ok",
				reasonCode: downgraded ? "c07_downgraded_proceed_to_narrow" : null,
			}),
		);

		const lines = [
			`*Verdict:* ${verdict.verdict}${downgraded ? ` _(downgraded from proceed — \`${verdict.evidence_basis}\` cannot proceed; needs field-behaviour or field-committed, C-07/I1)_` : ""}`,
			`*Evidence basis:* ${verdict.evidence_basis}`,
			`*Load-bearing assumption:* ${verdict.load_bearing_assumption}`,
			`*Strongest reason this fails:* ${verdict.strongest_failure_reason}`,
			`*What would change the verdict:* ${verdict.what_would_change_verdict}`,
			`*Evidence quality:* ${verdict.evidence_quality}`,
		];
		if (verdict.who_to_talk_to) {
			lines.push(`*Who to talk to:* ${verdict.who_to_talk_to}`);
		}
		if (verdict.resembles_killed_idea) {
			lines.push(`*⚠️ Resembles killed idea:* \`${verdict.resembles_killed_idea}\` — the auditor weighed that kill reason (I3).`);
		}
		const verdictPost = await postResult(client, {
			channel: researchChannel,
			thread_ts: auditThreadTs || research.json.slack_thread_ts,
			text: lines.join("\n"),
		});

		// D-52: refresh the pinned state card before any archive-on-kill --
		// a card update on an archived channel would fail.
		if (pdest.project) await upsertStateCard(client, id, { latestTs: verdictPost?.ts, latestChannel: researchChannel });

		if (verdict.verdict === "kill" && graveyardChannel) {
			await client.chat.postMessage({
				channel: graveyardChannel,
				text: `\`${id}\` killed — ${verdict.strongest_failure_reason}${pdest.project ? ` (was <#${pdest.project.channel_id}>)` : ""}`,
			});
		}

		// 18.1: archive the project channel on a kill, after the verdict is
		// posted. The verdict stands even if archiving fails.
		if (verdict.verdict === "kill" && pdest.project?.channel_id) {
			try {
				await client.conversations.archive({ channel: pdest.project.channel_id });
			} catch (archErr) {
				const why = archErr?.data?.error || archErr?.message || archErr;
				console.error(`audit: channel archive failed for ${id}: ${why}`);
				if (graveyardChannel) {
					await client.chat
						.postMessage({ channel: graveyardChannel, text: `⚠️ couldn't archive <#${pdest.project.channel_id}> for killed \`${id}\` (${why}) — archive it by hand. The verdict stands.` })
						.catch(() => {});
				}
			}
		}
	} catch (err) {
		console.error("audit command failed:", err);
		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder: invoker,
				ideaId: id,
				status: "failed",
				reasonCode: "audit_call_failed",
			}),
		);
		await client.chat
			.postMessage({
				channel: researchChannel,
				text: `\`/audit\` failed for \`${id}\`: ${err?.message || err}`,
			})
			.catch(() => {});
	}
}

module.exports = {
	handleAuditCommand,
	runAudit,
	parseAuditResponse,
	appendToGraveyard,
	enforceEvidenceGate,
};
