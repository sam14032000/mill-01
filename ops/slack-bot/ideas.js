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

module.exports = { IDEAS_DIR, ideaExists, generateIdeaId, createIdea };
