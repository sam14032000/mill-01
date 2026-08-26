"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MINDS_DIR = path.join(REPO_ROOT, "minds");

function readProfile(founder) {
	try {
		return fs.readFileSync(path.join(MINDS_DIR, founder, "profile.md"), "utf8");
	} catch {
		return "";
	}
}

function readDynamics() {
	try {
		return fs.readFileSync(path.join(MINDS_DIR, "shared", "dynamics.md"), "utf8");
	} catch {
		return "";
	}
}

// Rough estimate only, for the ~8000-token context cap in
// docs/COMMANDS.md -- no tokenizer wired in, and this doesn't need to
// be exact to do its job (keep runaway context from tripling brainstorm
// cost, per the runbook's caching note).
const CHARS_PER_TOKEN_ESTIMATE = 4;

// Capture lines for a founder, most recent first. docs/COMMANDS.md's
// context-assembly spec: "last 20 captures ... cap at 20 entries or
// ~8000 tokens, whichever is smaller" for most commands; /themes wants
// "last 30 days" instead, uncapped by entry count. Both are this one
// function with different options.
function readCaptures(founder, { maxEntries = Infinity, maxDays = Infinity, maxTokens = Infinity } = {}) {
	const dir = path.join(MINDS_DIR, founder, "captures");
	let files;
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
	files.sort().reverse(); // filenames are YYYY-MM-DD.md -- lexicographic order is chronological

	const cutoff =
		maxDays === Infinity ? null : new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000);
	let charBudget = maxTokens === Infinity ? Infinity : maxTokens * CHARS_PER_TOKEN_ESTIMATE;

	const lines = [];
	for (const file of files) {
		const dateStr = file.replace(".md", "");
		if (cutoff && new Date(dateStr) < cutoff) break;

		const content = fs.readFileSync(path.join(dir, file), "utf8");
		// Lines are appended chronologically within a file, so the last
		// line written is the most recent capture of that day.
		const fileLines = content
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.reverse();

		for (const line of fileLines) {
			if (lines.length >= maxEntries) return lines;
			if (line.length > charBudget) return lines;
			charBudget -= line.length;
			lines.push(`${dateStr} ${line}`);
		}
	}
	return lines;
}

module.exports = { readProfile, readDynamics, readCaptures, MINDS_DIR };
