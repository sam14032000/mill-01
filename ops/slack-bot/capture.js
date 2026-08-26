"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MINDS_DIR = path.join(REPO_ROOT, "minds");

function todayStamp(date = new Date()) {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

function timeStamp(date = new Date()) {
	const h = String(date.getHours()).padStart(2, "0");
	const m = String(date.getMinutes()).padStart(2, "0");
	return `${h}:${m}`;
}

// Appends raw, unedited, per runbook Stage 1. Returns the path written to.
function writeCapture(founder, text) {
	const capturesDir = path.join(MINDS_DIR, founder, "captures");
	fs.mkdirSync(capturesDir, { recursive: true });
	const file = path.join(capturesDir, `${todayStamp()}.md`);
	const line = `- ${timeStamp()} — ${text}\n`;
	fs.appendFileSync(file, line, "utf8");
	return file;
}

module.exports = { writeCapture, MINDS_DIR };
