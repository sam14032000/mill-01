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

const COMPRESSOR_SYSTEM_PROMPT = [
	"You are producing one entry in this idea's audit-reference.md — an ATTRIBUTED TRANSCRIPTION of the raw turns",
	"below, not a bias-removal pass and not a summary of who was right. Record what was claimed. For every claim,",
	"mark its source as exactly one of: [SOURCE: research-<stamp>] (it came from a retrieved report — cite the",
	"specific stamp from the header below), [FOUNDER BELIEF] (a founder said it, unsourced), or [REPORTED SPEECH]",
	"(a founder is relaying something a real person outside the mill said to them).",
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
	"- If a claim in these turns is factually incompatible with a finding in a report listed below -- even if the",
	"  founder never mentions the report or seems unaware of it -- flag it explicitly:",
	"  'CONTRADICTS research-<stamp>: ...'. This applies whether or not the founder engaged with the report; the",
	"  point is that evidence exists which undercuts the claim, whether it was set aside knowingly or never seen.",
	"  A report that's simply irrelevant to these turns still gets NOT DISCUSSED, not CONTRADICTS -- but check every",
	"  report's findings against every number/claim in these turns before deciding which bucket applies, and use",
	"  BOTH tags on the same report if it is both unreferenced by the founder AND factually incompatible.",
	"- If the running header lists a research pass that these turns never reference at all, flag it: 'NOT DISCUSSED:",
	"  research-<stamp> exists but was not mentioned in this window.' Same failure, quieter.",
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
	const messages = [
		{ role: "system", content: COMPRESSOR_SYSTEM_PROMPT },
		{
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
		},
	];
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
	compressAndAppend,
	maybeCompress,
	COMPRESSOR_SYSTEM_PROMPT,
};
