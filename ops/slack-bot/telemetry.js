"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TELEMETRY_DIR = path.join(REPO_ROOT, "telemetry");

// docs/COMMANDS.md specifies telemetry "per the EVAL.md schema", but
// docs/EVAL.md doesn't exist in the repo yet (CLAUDE.md only notes it's
// deliberately not imported -- it doesn't say it's been written). This
// schema is a working assumption: one JSON object per line, always
// {ts, command, founder, status}, with event-specific fields (idea_id,
// reason, ...) added on top. Kept flat and additive so it can be
// reconciled without a rewrite once EVAL.md actually lands.
function emit(event) {
	fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
	const now = new Date();
	const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
	const file = path.join(TELEMETRY_DIR, `${stamp}.jsonl`);
	const line = `${JSON.stringify({ ts: now.toISOString(), ...event })}\n`;
	fs.appendFileSync(file, line, "utf8");
}

module.exports = { emit, TELEMETRY_DIR };
