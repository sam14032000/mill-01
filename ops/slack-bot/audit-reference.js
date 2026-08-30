"use strict";

// Change 4 (docs/build-prompt-modes.md): `ideas/<id>/audit-reference.md`
// -- append-only, timestamped, compressed by flash-fast every 5 turns,
// across all modes. This is what lets the auditor see the founders'
// actual reasoning (D-28's artifact-only scoping threw that away)
// without ever reading the raw thread, which stays off-limits (D-28
// itself is unchanged: no brainstorm transcript, no enthusiasm).
//
// The compressor is the most sensitive prompt in the system (see the
// spec's own framing) because it decides what the audit gate sees. It is
// framed as ATTRIBUTED TRANSCRIPTION, not bias removal, to design against
// two specific failure modes:
//
//   1. Over-stripping -- an argument containing a fact is not a bias.
//      "Shiprocket X bundles this free so brands won't pay separately"
//      must survive; only the conviction around it goes.
//   2. Laundering -- compression must never upgrade speculation into
//      finding. "We think brands would pay ₹15k" cannot become "brands
//      pay ₹15k." That is fabricated evidence arriving by a new route,
//      and D-33 exists to block exactly this.

const fs = require("node:fs");
const path = require("node:path");
const { IDEAS_DIR } = require("./ideas");
const { callFlash } = require("./llm");
const { personaFor } = require("./personas");

const MODEL = "flash-fast";
const COMPRESS_EVERY_N_TURNS = Number(process.env.MILL_COMPRESS_EVERY_N_TURNS) || 5;

function referencePath(id) {
	return path.join(IDEAS_DIR, id, "audit-reference.md");
}

function readReference(id) {
	const p = referencePath(id);
	if (!fs.existsSync(p)) return null;
	return fs.readFileSync(p, "utf8");
}

// APPEND-ONLY. Never rewrite an earlier entry -- a later contradiction is
// appended, not resolved, so the auditor can see the founders change
// their mind. Enforced structurally here: this function only ever calls
// appendFileSync, never writeFileSync, on an existing reference doc.
function appendEntry(id, entryMd) {
	const p = referencePath(id);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const stamp = new Date().toISOString();
	const block = `\n---\n### ${stamp}\n\n${entryMd.trim()}\n`;
	fs.appendFileSync(p, block, "utf8");
	return p;
}

// The running header: every research pass this idea has had, so the
// auditor sees the full evidence set even where the conversation never
// mentioned a report (one of the two "evidence set aside" failure modes
// this doc exists to catch).
function researchHeader(id) {
	const dir = path.join(IDEAS_DIR, id);
	let files = [];
	try {
		files = fs.readdirSync(dir).filter((f) => /^research-\d{8}-\d{4}\.json$/.test(f));
	} catch {
		return [];
	}
	files.sort();
	return files.map((f) => {
		const stamp = f.replace("research-", "").replace(".json", "");
		let json = {};
		try {
			json = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
		} catch {
			/* malformed research json shouldn't crash the compressor */
		}
		return { stamp, assumption: json.assumption || null, evidence_basis: json.evidence_basis || "unknown" };
	});
}

function researchHeaderText(id) {
	const header = researchHeader(id);
	if (!header.length) return "(no research passes have run for this idea yet)";
	return header.map((r) => `- research-${r.stamp}: "${r.assumption || "(no assumption recorded)"}" — evidence_basis: ${r.evidence_basis}`).join("\n");
}

// The findings themselves, not just the header line.
//
// Found live: the CONTRADICTS instruction in the compressor prompt asks
// the model to check each claim against each report's FINDINGS, but the
// only research context it was given was researchHeaderText() above --
// stamp, assumption, evidence_basis. Titles, not contents. So a founder
// claiming brands pay >Rs25k against a report finding no brand pays more
// than Rs12k could never be flagged, because the Rs12k figure was never
// in the prompt. The instruction was unimplementable, and the model's
// refusal to fire looked like judgement when it was blindness.
//
// Capped per report and in total: compression runs every 5 turns, so an
// uncapped report body would be re-sent on every compression for the
// life of the idea. Passed as a stable system message (see
// compressAndAppend) rather than inline with the volatile turns, so it
// sits in the cached prefix -- CLAUDE.md's context-assembly rule.
const FINDINGS_CHARS_PER_REPORT = Number(process.env.MILL_COMPRESS_FINDINGS_CHARS) || 2000;
const FINDINGS_CHARS_TOTAL = Number(process.env.MILL_COMPRESS_FINDINGS_TOTAL) || 8000;

function researchFindingsText(id) {
	const dir = path.join(IDEAS_DIR, id);
	const header = researchHeader(id);
	if (!header.length) return null;
	const chunks = [];
	let used = 0;
	for (const r of header) {
		if (used >= FINDINGS_CHARS_TOTAL) break;
		let md = "";
		try {
			md = fs.readFileSync(path.join(dir, `research-${r.stamp}.md`), "utf8");
		} catch {
			continue; // json without a readable md -- header line still covers it
		}
		const budget = Math.min(FINDINGS_CHARS_PER_REPORT, FINDINGS_CHARS_TOTAL - used);
		const body = md.length > budget ? `${md.slice(0, budget)}\n…[report truncated for length]` : md;
		used += body.length;
		chunks.push(`--- research-${r.stamp} (evidence_basis: ${r.evidence_basis}) ---\n${body}`);
	}
	return chunks.length ? chunks.join("\n\n") : null;
}

const COMPRESSOR_SYSTEM_PROMPT = [
	"You are producing one entry in this idea's audit-reference.md — an ATTRIBUTED TRANSCRIPTION of the raw turns",
	"below, not a bias-removal pass and not a summary of who was right. Record what was claimed. For every claim,",
	"mark its source as exactly one of these four tags, copied verbatim including the disclaimer text:",
	"",
	"  [SOURCE: research-<stamp>]            — it came from a retrieved research report. Cite the specific stamp",
	"                                          from the running header below. This is the ONLY tag that marks",
	"                                          something the audit gate may count as evidence.",
	"  [SURFACE SEARCH — not evidence]       — it came from a surface web search (`/find`) whose result appeared in",
	"                                          the thread. NEVER tag surface search as [SOURCE: research-…]: no",
	"                                          sources were verified, there was no citation re-check, and only",
	"                                          `/test` produces something an audit can rule on.",
	"  [FOUNDER BELIEF]                      — a founder said it, unsourced.",
	"  [RELAYED — not field evidence]        — a founder is relaying something a person outside the mill said to",
	"                                          them. This is the founder's characterisation of a conversation, not",
	"                                          the conversation itself, so it is NEVER a substitute for graded",
	"                                          field notes and never counts toward evidence_basis. Use it even when",
	"                                          the relayed claim sounds strong — especially then.",
	"",
	"If a claim could take more than one tag, use the weaker one. The tags carry their own disclaimers so that a",
	"reader who sees only this file, with no other instructions, still cannot mistake a non-evidence claim for",
	"evidence.",
	"",
	"Keep every specific: numbers, named competitors, named regulations, prices, percentages. Do not summarise them",
	"away. An argument that contains a fact is not a bias to strip — only the conviction and rhetorical framing",
	"around it goes; the fact stays. Example: \"Shiprocket X already bundles this for free so nobody will pay",
	"separately\" must survive as a claim tagged [FOUNDER BELIEF] with the specific (Shiprocket X, bundled, free)",
	"intact — do not reduce it to \"competitive concerns were raised.\"",
	"",
	"NEVER upgrade speculation into a finding. \"We think brands would pay ₹15k\" must be recorded as exactly that —",
	"a founder belief about a hypothetical price — and must NEVER be rewritten as \"brands pay ₹15k\" or any other",
	"phrasing that reads as an observed fact. This is the single most important rule here: doing this fabricates",
	"evidence by a new route and defeats the entire reason field evidence is graded (D-33/D-49).",
	"",
	"Required in your output:",
	"- State which MODE produced this turn (given below).",
	"- Cite the specific research-<stamp> a claim draws on, using the running header below — do not invent a stamp.",
	"- CONTRADICTS. Run this check explicitly, as a procedure, before you write any flags. For EACH report in the",
	"  running header, and for EACH claim in these turns, ask two questions in order:",
	"    (a) Does the claim assert a value for THE SAME QUANTITY the report measures? Same quantity means same",
	"        thing AND same tense/mode: what someone currently pays is one quantity; what someone WOULD pay or",
	"        would be willing to pay is a DIFFERENT quantity. The mill already draws exactly this line when it",
	"        grades stated intent separately from observed behaviour.",
	"    (b) If (a) is yes: are the two values compatible?",
	"  If (a) is yes and (b) is no, you MUST emit 'CONTRADICTS research-<stamp>: ...' naming both numbers. Do not",
	"  soften it, do not settle for NOT DISCUSSED instead, and do not skip it because the founder never mentioned",
	"  the report — a founder who never saw the evidence is still contradicted by it. If (a) is no, do NOT emit",
	"  CONTRADICTS for that pair, however large the numeric gap looks.",
	"",
	"  Worked example, (a) = NO: founder says \"brands will pay ₹15k, way more than a consultant\"; report finds",
	"  consultants charge ₹8–12k. Different quantities (willingness-to-pay vs current price). NOT a contradiction —",
	"  the report supplies the baseline the founder is reasoning from and is consistent with the comparison. Only",
	"  the willingness-to-pay half is unsupported, which the [FOUNDER BELIEF] tag already records.",
	"",
	"  Worked example, (a) = YES and (b) = NO: founder says 25% of brands CURRENTLY PAY >₹25k/month; that same",
	"  report finds no brand currently pays more than ₹12k. Same quantity (current spend), incompatible values.",
	"  This one MUST fire CONTRADICTS.",
	"",
	"  Both errors are costly and neither is the safe default. A CONTRADICTS you failed to emit means the gate",
	"  never learns that the only evidence on file undercuts the founder's number — which is the single most",
	"  common way a founder talks past a kill. A CONTRADICTS you emitted wrongly tells the gate a founder is",
	"  ignoring evidence when they are not. The two-question check above is what separates them; apply it rather",
	"  than guessing at which error to prefer.",
	"- If the running header lists a research pass that these turns never reference at all, flag it: 'NOT DISCUSSED:",
	"  research-<stamp> exists but was not mentioned in this window.' Same failure, quieter.",
	"- THE TWO FLAGS ARE INDEPENDENT AND OFTEN BOTH APPLY TO THE SAME REPORT. NOT DISCUSSED answers 'did the",
	"  founder engage with this report?'; CONTRADICTS answers 'is a claim here incompatible with it?'. A report",
	"  the founder never mentioned AND whose findings contradict a claim gets BOTH lines. Emitting only NOT",
	"  DISCUSSED when the contradiction check above came back positive is a failure, not a simplification.",
	"",
	"Output plain text, not JSON. Structure: one paragraph or short list per distinct claim, each tagged with its",
	"source marker. End with any CONTRADICTS/NOT DISCUSSED flags as their own lines.",
].join("\n");

function formatTurnsForCompressor(turns) {
	return turns
		.map((t) => `${t.role === "user" ? "Founder" : "Mill"}${t.userId ? ` (${t.userId})` : ""}: ${t.text}`)
		.join("\n");
}

// Runs the compressor over a window of raw turns and appends the result.
// `turns` are the raw {role, text, userId} objects from a session -- this
// is the only place in Change 4 that ever sees them; the audit tool
// itself (commands/audit.js) reads only the compressed output this
// produces, never turns directly.
async function compressAndAppend(id, { turns, mode }) {
	if (!turns || !turns.length) return null;
	const persona = personaFor(mode);
	const header = researchHeaderText(id);
	const findings = researchFindingsText(id);
	const messages = [{ role: "system", content: COMPRESSOR_SYSTEM_PROMPT }];
	// Stable within an idea -> cached prefix, ahead of the volatile turns.
	if (findings) {
		messages.push({
			role: "system",
			content:
				"Findings of every research pass run for this idea. These are what the CONTRADICTS check compares " +
				"claims against — read the actual numbers here, not just the header line:\n\n" +
				findings,
		});
	}
	messages.push({
		role: "user",
		content: [
			`Mode: ${mode} (${persona.label})`,
			"",
			"Research passes run so far, for citation and NOT-DISCUSSED checking:",
			header,
			"",
			"--- Raw turns to compress ---",
			formatTurnsForCompressor(turns),
		].join("\n"),
	});
	const { content: text, usage, costUsd, cacheHit } = await callFlash(messages, { model: MODEL, maxTokens: 3072 });
	const entry = `**Mode:** ${mode}\n\n${text.trim()}`;
	appendEntry(id, entry);
	return { entry, usage, costUsd, cacheHit };
}

// Turn-count trigger: called from chat-session.js's addTurn for project
// sessions. Compresses every COMPRESS_EVERY_N_TURNS turns, across all
// modes -- not scoped to one mode's document, since the reference doc's
// whole point is to hold reasoning that never made it into any document.
async function maybeCompress(id, mode, allTurns) {
	if (allTurns.length === 0 || allTurns.length % COMPRESS_EVERY_N_TURNS !== 0) return null;
	const window = allTurns.slice(-COMPRESS_EVERY_N_TURNS);
	try {
		return await compressAndAppend(id, { turns: window, mode });
	} catch (err) {
		console.error(`audit-reference: compression failed for ${id}: ${err.message}`);
		return null;
	}
}

module.exports = {
	referencePath,
	readReference,
	appendEntry,
	researchHeader,
	researchHeaderText,
	researchFindingsText,
	compressAndAppend,
	maybeCompress,
	COMPRESSOR_SYSTEM_PROMPT,
};
