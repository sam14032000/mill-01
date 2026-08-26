"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TELEMETRY_DIR = path.join(REPO_ROOT, "telemetry");

// India Standard Time is a fixed +05:30 offset, no DST -- safe to
// hardcode rather than pull in a timezone library for one conversion.
// docs/EVAL.md's Layer 2 schema example uses this offset explicitly
// ("2026-09-03T14:22:00+05:30"), not UTC.
function istTimestamp(date = new Date()) {
	const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
	const pad = (n) => String(n).padStart(2, "0");
	return (
		`${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}` +
		`T${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}+05:30`
	);
}

// docs/EVAL.md Layer 2: one JSON object per line, {ts, founder, stage,
// idea_id, model, tokens_in, tokens_out, cache_hit_ratio, cost_usd,
// wall_clock_s, verdict, evidence_basis, reason_code}. Per-command
// builders (e.g. commands/attack.js's buildTelemetryEvent) fill this
// shape in; this module only adds ts and writes the line. status is not
// in EVAL.md's example but is required by docs/COMMANDS.md's own
// telemetry section ("Emit on failure too, with status: failed and a
// reason") -- both specs are satisfied by callers, not enforced here.
function emit(event) {
	fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
	const now = new Date();
	const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
	const file = path.join(TELEMETRY_DIR, `${stamp}.jsonl`);
	const line = `${JSON.stringify({ ts: istTimestamp(now), ...event })}\n`;
	fs.appendFileSync(file, line, "utf8");
}

module.exports = { emit, TELEMETRY_DIR, istTimestamp };
