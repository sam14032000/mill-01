"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Same file systemd's EnvironmentFile= points at (Part 7/9). Read directly
// from disk, not process.env, so a SIGHUP can pick up edits without a
// process restart -- process.env is fixed at spawn time and can't change
// underneath a running node process.
const ENV_FILE =
	process.env.MILL_ENV_FILE || path.join(os.homedir(), ".config", "mill", "env");

// D-40: identity comes only from Slack's verified user_id against a static
// map. FOUNDER_AMISHA / FOUNDER_VAIBHAV may be blank while those founders
// haven't been onboarded yet -- blank and invalid entries are filtered out,
// not treated as errors, so the bot still runs with a partial roster.
const FOUNDER_KEYS = {
	FOUNDER_SAKSHAM: "saksham",
	FOUNDER_AMISHA: "amisha",
	FOUNDER_VAIBHAV: "vaibhav",
};

// Channel IDs come from env, never hardcoded -- #mill collided with the
// bot's own name in the actual workspace, so the channel is #mill-ideas;
// keeping the id in config instead of the source means a rename never
// requires a code change.
const CHANNEL_KEYS = {
	SLACK_CHANNEL_MILL: "mill",
	SLACK_CHANNEL_RESEARCH: "research",
	SLACK_CHANNEL_GRAVEYARD: "graveyard",
};

let allowlist = Object.freeze({});
let channels = Object.freeze({});

function parseEnvFile(filePath) {
	const raw = fs.readFileSync(filePath, "utf8");
	const out = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		out[key] = value;
	}
	return out;
}

// Re-reads ENV_FILE and rebuilds both the allowlist and the channel map.
// Called at startup, on SIGHUP, and (implicitly, via process restart) by
// `systemctl restart mill-chat` -- adding a founder later is just editing
// the env file and one of those two, never a code change.
function load() {
	let vars;
	try {
		vars = parseEnvFile(ENV_FILE);
	} catch (err) {
		console.error(
			`config: failed to read ${ENV_FILE}: ${err.message} — keeping previous config`,
		);
		return;
	}

	const newAllowlist = {};
	const active = [];
	const missing = [];
	for (const [envKey, founder] of Object.entries(FOUNDER_KEYS)) {
		const value = vars[envKey];
		if (!value) {
			missing.push(founder);
			continue;
		}
		if (!value.startsWith("U")) {
			console.error(
				`config: ${envKey} is set but doesn't look like a Slack user ID (must start with "U") — skipping ${founder}`,
			);
			missing.push(founder);
			continue;
		}
		newAllowlist[value] = founder;
		active.push(founder);
	}
	allowlist = Object.freeze(newAllowlist);

	const newChannels = {};
	for (const [envKey, name] of Object.entries(CHANNEL_KEYS)) {
		if (vars[envKey]) newChannels[name] = vars[envKey];
	}
	channels = Object.freeze(newChannels);

	// Visible at startup and on every reload, so a missing founder shows
	// up in the log rather than silently producing "no reply" DMs.
	console.log(
		`config: active founders: ${active.length ? active.join(", ") : "(none)"}` +
			(missing.length ? ` — not active: ${missing.join(", ")}` : ""),
	);
	const configuredChannels = Object.keys(newChannels);
	const missingChannels = Object.values(CHANNEL_KEYS).filter(
		(name) => !configuredChannels.includes(name),
	);
	console.log(
		`config: channels: ${configuredChannels.length ? configuredChannels.join(", ") : "(none)"}` +
			(missingChannels.length ? ` — not set: ${missingChannels.join(", ")}` : ""),
	);
}

function founderForUserId(userId) {
	return allowlist[userId] || null;
}

function channelId(name) {
	return channels[name] || null;
}

load();

module.exports = { load, founderForUserId, channelId, ENV_FILE };
