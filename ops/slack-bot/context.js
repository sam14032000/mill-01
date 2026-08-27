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

// Measured directly (building /cross): with an empty or near-empty
// profile, the model does not refuse or hedge when asked to attack an
// idea "from the angle this founder's profile says they'd miss" -- it
// produces a full, confident, plausible-sounding reading anyway, which
// is worse than an explicit "no profile yet" message because it's
// indistinguishable from a working, personalized read. Anything below
// this length isn't "how this founder fails" (D-26), it's not
// describing anything yet -- shared by every command that reads a
// profile into its prompt, not just /cross, so it lives here rather
// than being redefined per command.
const MIN_PROFILE_LENGTH = 50;

function hasProfile(founder) {
	return readProfile(founder).trim().length >= MIN_PROFILE_LENGTH;
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

// --- Project documents (build-guide-projects 17.4) --------------------
// Default: brainstorm sees ideas/<id>/docs/index.md only. `@filename`
// pulls one document's full text for that call; `@all` pulls everything.
// This keeps a 47-page report from being re-sent across twenty turns.

const IDEAS_DIR = path.join(REPO_ROOT, "ideas");

// Splits a leading "@token" (a document mention) off the command text.
function parseDocMention(text) {
	const m = String(text || "").match(/^\s*(@\S+)\s+([\s\S]+)$/);
	if (!m) return { mention: null, rest: text };
	return { mention: m[1], rest: m[2] };
}

function readDocIndex(ideaId) {
	try {
		return fs.readFileSync(path.join(IDEAS_DIR, ideaId, "docs", "index.md"), "utf8");
	} catch {
		return "";
	}
}

// Returns the document-context block for a command, given an optional
// mention. Empty string means "no documents".
function readProjectDocs(ideaId, mention) {
	const docsDir = path.join(IDEAS_DIR, ideaId, "docs");

	if (mention === "@all") {
		let files;
		try {
			files = fs.readdirSync(docsDir).filter((f) => f !== "index.md" && !f.startsWith("."));
		} catch {
			return "";
		}
		const parts = [];
		let budget = 400_000;
		for (const f of files) {
			let content = "";
			try {
				content = fs.readFileSync(path.join(docsDir, f), "utf8");
			} catch {
				continue;
			}
			const block = `--- ${f} ---\n${content}`;
			if (block.length > budget) break;
			budget -= block.length;
			parts.push(block);
		}
		return parts.join("\n\n");
	}

	if (mention && mention.startsWith("@")) {
		const name = path.basename(mention.slice(1)); // strip any path parts
		const p = path.join(docsDir, name);
		if (path.dirname(p) !== docsDir) return `(bad document name: ${name})`;
		try {
			return `--- ${name} ---\n${fs.readFileSync(p, "utf8")}`;
		} catch {
			return `(no document named ${name} in this project)`;
		}
	}

	return ""; // default -- caller falls back to the index
}

module.exports = {
	readProfile,
	readDynamics,
	readCaptures,
	hasProfile,
	parseDocMention,
	readDocIndex,
	readProjectDocs,
	MIN_PROFILE_LENGTH,
	MINDS_DIR,
};
