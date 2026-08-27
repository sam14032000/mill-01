"use strict";

// build-guide-projects Part 14.7 / PROJECTS.md: "Nightly, each founder's
// own messages from unpromoted chats are appended to their captures file
// -- so raw thinking is never lost, per the raw-capture rule."
//
// Departs from the guide's "cron" sketch for the same reason weekly
// profile evolution did (ops/BUILD-LOG.md Part 12): the session state
// this reads lives in the always-on bot process, and a separate
// cron-invoked script would race the bot's own persistence writes. Runs
// as an in-process poll, like weekly-scheduler.js. The 15-minute
// git-batch loop commits the resulting minds/ changes.

const { writeCapture } = require("./capture");
const { drainForNightlyCapture } = require("./chat-session");
const { emit } = require("./telemetry");
const { buildEvalEvent } = require("./eval-event");

// 20:00 UTC = 01:30 IST -- founders asleep, well clear of the 04:00 UTC
// weekly profile-evolution window.
const TARGET_UTC_HOUR = 20;
const WINDOW_MINUTES = 10;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

let lastRunDate = null; // "YYYY-MM-DD" (UTC) -- once per day

function inWindow(now) {
	return now.getUTCHours() === TARGET_UTC_HOUR && now.getUTCMinutes() < WINDOW_MINUTES;
}

function runNightlyChatCapture() {
	const drained = drainForNightlyCapture();
	let founders = 0;
	let lines = 0;
	for (const { founder, lines: founderLines } of drained) {
		founders += 1;
		for (const text of founderLines) {
			// Tagged so it's distinguishable from a DM capture on review.
			writeCapture(founder, `(chat) ${text}`);
			lines += 1;
		}
	}
	console.log(`nightly-capture: appended ${lines} line(s) across ${founders} founder(s)`);
	emit(
		buildEvalEvent({
			stage: "nightly_capture",
			model: null,
			founder: null,
			status: "ok",
			reasonCode: `founders_${founders}_lines_${lines}`,
		}),
	);
	return { founders, lines };
}

function startNightlyScheduler(onFailure) {
	return setInterval(() => {
		const now = new Date();
		if (!inWindow(now)) return;
		const today = now.toISOString().slice(0, 10);
		if (lastRunDate === today) return;
		lastRunDate = today;
		try {
			runNightlyChatCapture();
		} catch (err) {
			onFailure?.(String(err?.message || err));
		}
	}, CHECK_INTERVAL_MS);
}

module.exports = { startNightlyScheduler, runNightlyChatCapture, inWindow };
