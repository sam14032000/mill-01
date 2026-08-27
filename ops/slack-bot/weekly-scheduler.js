"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// The box runs in UTC (confirmed directly, not assumed: `timedatectl`
// shows Etc/UTC). Sunday 09:30 IST = Sunday 04:00 UTC (IST is a fixed
// +05:30, no DST) -- checked against a window, not an exact minute,
// since this runs on a periodic poll rather than true cron.
const TARGET_UTC_DAY = 0; // Sunday
const TARGET_UTC_HOUR = 4;
const WINDOW_MINUTES = 10;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const MARKER_FILE = path.join(os.homedir(), ".cache", "mill-healthcheck", "profile-evolution-last-run");

function isoWeek(date) {
	// ISO week number, used purely as a "have we already run this week"
	// marker -- doesn't need to be calendar-perfect, just monotonic and
	// stable within a single Sunday.
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
	return `${d.getUTCFullYear()}-W${week}`;
}

function alreadyRanThisWeek(now) {
	try {
		const last = fs.readFileSync(MARKER_FILE, "utf8").trim();
		return last === isoWeek(now);
	} catch {
		return false;
	}
}

function markRan(now) {
	fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true });
	fs.writeFileSync(MARKER_FILE, isoWeek(now), "utf8");
}

function inWindow(now) {
	if (now.getUTCDay() !== TARGET_UTC_DAY) return false;
	if (now.getUTCHours() !== TARGET_UTC_HOUR) return false;
	return now.getUTCMinutes() < WINDOW_MINUTES;
}

// Polling rather than a true cron scheduler: this process already has a
// 5-minute-scale poll loop pattern (git-batch.js's 15-minute interval),
// and adding a second always-on interval is simpler and more visible in
// one log stream than shelling out to a separate cron-invoked script
// that would need its own way to trigger the same interactive
// approve/reject flow this requires (Socket Mode's persistent
// connection lives in this process, not a one-shot script).
function startWeeklyScheduler(runFn, onFailure) {
	return setInterval(() => {
		const now = new Date();
		if (!inWindow(now)) return;
		if (alreadyRanThisWeek(now)) return;

		markRan(now); // mark before running so a slow/failed run doesn't cause a retry storm within the window
		console.log("weekly-scheduler: running profile evolution");
		Promise.resolve(runFn()).catch((err) => onFailure?.(String(err?.message || err)));
	}, CHECK_INTERVAL_MS);
}

module.exports = { startWeeklyScheduler, inWindow, isoWeek, alreadyRanThisWeek, markRan, MARKER_FILE };
