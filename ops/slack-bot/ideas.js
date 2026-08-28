"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const IDEAS_DIR = path.join(REPO_ROOT, "ideas");

function ideaExists(id) {
	return fs.existsSync(path.join(IDEAS_DIR, id));
}

// 4-char lowercase hex, generated at /attack, collision-checked against
// existing ideas/ (docs/COMMANDS.md's idea-lifecycle spec). Collisions
// are unlikely at 65,536 possible ids but the id is the primary key, so
// it's checked rather than assumed.
function generateIdeaId() {
	let id;
	do {
		id = crypto.randomBytes(2).toString("hex");
	} while (ideaExists(id));
	return id;
}

function nowIso() {
	return new Date().toISOString();
}

// Writes ideas/<id>/idea.md (origin text + assumption + founder) and
// state.json (state -> "open", per the States table). Only /attack
// creates ideas; every other command in docs/COMMANDS.md operates on
// one that already exists.
function createIdea({ id, founder, originText, caseText, assumption }) {
	const dir = path.join(IDEAS_DIR, id);
	fs.mkdirSync(dir, { recursive: true });

	const ts = nowIso();
	const ideaMd = [
		`# ${id}`,
		"",
		`**Founder:** ${founder}`,
		`**Created:** ${ts}`,
		"",
		"## Origin",
		"",
		originText,
		"",
		"## Case against",
		"",
		caseText,
		"",
		"## Assumption",
		"",
		assumption,
		"",
	].join("\n");
	fs.writeFileSync(path.join(dir, "idea.md"), ideaMd, "utf8");

	const state = {
		id,
		state: "open",
		founder,
		created_at: ts,
		updated_at: ts,
		touch_count: 0,
	};
	fs.writeFileSync(
		path.join(dir, "state.json"),
		`${JSON.stringify(state, null, 2)}\n`,
		"utf8",
	);

	return { dir, relPath: path.relative(REPO_ROOT, dir) };
}

// Promotion from a chat (docs/PROJECTS.md "Promotion", build-guide-
// projects Part 15.3). Unlike createIdea (which is /attack-only and
// requires an assumption), promotion always succeeds and the assumption
// is optional -- if the chat never ran /attack, the idea is created
// `open` with the assumption unset and /test is told it needs one.
// Writes idea.md, origin-chat.md (the FULL transcript -- promoting late
// must lose nothing), and state.json.
function promoteIdea({ id, founder, topic, assumption, originChatMd, originChatTs, summary, channelId = null, threads = {} }) {
	const dir = path.join(IDEAS_DIR, id);
	fs.mkdirSync(dir, { recursive: true });
	const ts = nowIso();

	const assumptionSection = assumption
		? assumption
		: "_Not set yet — this chat didn't run `/attack`. `/test` needs a named, falsifiable assumption; run `/attack <idea>` in the project's Brainstorm thread first._";

	const ideaMd = [
		`# ${id}`,
		"",
		`**Founder:** ${founder}`,
		`**Created:** ${ts}  (promoted from a chat)`,
		"",
		"## Origin",
		"",
		topic || "(no topic recorded)",
		"",
		"## Summary of origin chat",
		"",
		summary || "(no summary generated)",
		"",
		"## Assumption",
		"",
		assumptionSection,
		"",
	].join("\n");
	fs.writeFileSync(path.join(dir, "idea.md"), ideaMd, "utf8");
	fs.writeFileSync(path.join(dir, "origin-chat.md"), originChatMd || "(transcript unavailable)\n", "utf8");

	const state = {
		id,
		state: "open",
		founder,
		created_at: ts,
		updated_at: ts,
		origin: "chat",
		origin_chat_ts: originChatTs || null,
		has_assumption: Boolean(assumption),
		// The assumption text is carried here too (not just idea.md) so a
		// pre-filled /attack assumption is visible in state without parsing
		// markdown -- build-guide-projects 15 verification checks state.json.
		assumption: assumption || null,
		channel_id: channelId,
		threads, // { brainstorm, research, audit, prototype, documents }
		parent: null,
		children: [],
		touch_count: 0,
	};
	fs.writeFileSync(path.join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");

	return { dir, relPath: path.relative(REPO_ROOT, dir) };
}

function readState(id) {
	try {
		return JSON.parse(fs.readFileSync(path.join(IDEAS_DIR, id, "state.json"), "utf8"));
	} catch {
		return null;
	}
}

// Reverse lookup: which idea owns this Slack channel (Part 16 routing).
// Returns the state object (with `id`) or null.
function findIdeaByChannel(channelId) {
	let dirs;
	try {
		dirs = fs.readdirSync(IDEAS_DIR);
	} catch {
		return null;
	}
	for (const id of dirs) {
		const st = readState(id);
		if (st && st.channel_id && st.channel_id === channelId) return st;
	}
	return null;
}

function readIdeaMd(id) {
	try {
		return fs.readFileSync(path.join(IDEAS_DIR, id, "idea.md"), "utf8");
	} catch {
		return null;
	}
}

// Extracts the ASSUMPTION text back out of idea.md's "## Assumption"
// section, since state.json doesn't duplicate it -- idea.md is the
// single source of truth for the assumption text (docs/COMMANDS.md's
// file contract: "idea.md: origin text + assumption + founder").
function readAssumption(id) {
	const md = readIdeaMd(id);
	if (!md) return null;
	const match = md.match(/## Assumption\n\n([\s\S]+?)(\n\n|$)/);
	return match ? match[1].trim() : null;
}

// Finds the most recent research-<stamp>.{md,json} pair for an idea
// (a founder can /test the same idea more than once). Returns null if
// none exists yet.
// Sets/replaces the assumption on an existing idea (e.g. /attack run in
// a project's Brainstorm thread when promotion didn't carry one). Updates
// both idea.md's "## Assumption" section and state.json.
function setAssumption(id, assumption) {
	const dir = path.join(IDEAS_DIR, id);
	const mdPath = path.join(dir, "idea.md");
	let md = fs.readFileSync(mdPath, "utf8");
	if (/## Assumption\n\n[\s\S]*?(?=\n## |\n*$)/.test(md)) {
		md = md.replace(/(## Assumption\n\n)[\s\S]*?(?=\n## |\n*$)/, `$1${assumption}\n`);
	} else {
		md = `${md.replace(/\n*$/, "")}\n\n## Assumption\n\n${assumption}\n`;
	}
	fs.writeFileSync(mdPath, md, "utf8");
	updateState(id, { assumption, has_assumption: true });
}

// All raw field-evidence notes for an idea, concatenated newest-first.
// I1: the audit reads and *grades* these itself -- it must see the raw
// founder text, not a pre-assigned label.
function readFieldNotes(id) {
	const dir = path.join(IDEAS_DIR, id, "field");
	let files;
	try {
		files = fs.readdirSync(dir).filter((f) => /^notes-.*\.md$/.test(f)).sort().reverse();
	} catch {
		return "";
	}
	return files
		.map((f) => `--- ${f} ---\n${fs.readFileSync(path.join(dir, f), "utf8").trim()}`)
		.join("\n\n");
}

// I2: what real people did when they saw the prototype. Feeds the audit.
function readOutcomes(id) {
	try {
		return fs.readFileSync(path.join(IDEAS_DIR, id, "outcomes.md"), "utf8");
	} catch {
		return "";
	}
}

function appendOutcome(id, { founder, requestCount, durationMin, text }) {
	const p = path.join(IDEAS_DIR, id, "outcomes.md");
	const stamp = nowIso();
	const block =
		`\n## ${stamp} — ${founder}\n` +
		`mount duration: ${durationMin} min · tunnel requests: ${requestCount == null ? "unknown" : requestCount}\n\n` +
		`${(text || "").trim()}\n`;
	fs.appendFileSync(p, block, "utf8");
	return p;
}

function readLatestResearch(id) {
	const dir = path.join(IDEAS_DIR, id);
	let files;
	try {
		files = fs.readdirSync(dir).filter((f) => /^research-\d{8}-\d{4}\.json$/.test(f));
	} catch {
		return null;
	}
	if (files.length === 0) return null;
	files.sort(); // stamps are YYYYMMDD-HHMM, lexicographic order is chronological
	const latestStamp = files[files.length - 1].replace("research-", "").replace(".json", "");

	const json = JSON.parse(fs.readFileSync(path.join(dir, `research-${latestStamp}.json`), "utf8"));
	let md = "";
	try {
		md = fs.readFileSync(path.join(dir, `research-${latestStamp}.md`), "utf8");
	} catch {
		md = "";
	}
	return { stamp: latestStamp, json, md };
}

function updateState(id, patch) {
	const current = readState(id);
	if (!current) throw new Error(`updateState: no state.json for idea ${id}`);
	const next = { ...current, ...patch, updated_at: nowIso() };
	fs.writeFileSync(
		path.join(IDEAS_DIR, id, "state.json"),
		`${JSON.stringify(next, null, 2)}\n`,
		"utf8",
	);
	return next;
}

module.exports = {
	IDEAS_DIR,
	ideaExists,
	generateIdeaId,
	createIdea,
	promoteIdea,
	findIdeaByChannel,
	setAssumption,
	readFieldNotes,
	readOutcomes,
	appendOutcome,
	readState,
	readIdeaMd,
	readAssumption,
	readLatestResearch,
	updateState,
	nowIso,
};
