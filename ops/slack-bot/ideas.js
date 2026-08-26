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

function readState(id) {
	try {
		return JSON.parse(fs.readFileSync(path.join(IDEAS_DIR, id, "state.json"), "utf8"));
	} catch {
		return null;
	}
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
	readState,
	readIdeaMd,
	readAssumption,
	readLatestResearch,
	updateState,
	nowIso,
};
