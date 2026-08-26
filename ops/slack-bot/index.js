"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { App } = require("@slack/bolt");
const https = require("node:https");

const { founderForUserId } = require("./allowlist");
const { writeCapture, MINDS_DIR } = require("./capture");
const { startBatchCommitLoop, commitCaptures } = require("./git-batch");

const REQUIRED_ENV = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
for (const key of REQUIRED_ENV) {
	if (!process.env[key]) {
		console.error(`missing required env var: ${key}`);
		process.exit(1);
	}
}

const app = new App({
	token: process.env.SLACK_BOT_TOKEN,
	appToken: process.env.SLACK_APP_TOKEN,
	socketMode: true,
});

// The eight slash commands defined in Slack app config (Part 9.1). Command
// logic lands in Part 9b per docs/COMMANDS.md, in the order recorded there:
// /attack, /think, /cross, /blindspot, /themes, /test, /audit, /proto.
const REGISTERED_COMMANDS = [
	"/think",
	"/cross",
	"/blindspot",
	"/attack",
	"/test",
	"/audit",
	"/proto",
	"/themes",
];

for (const command of REGISTERED_COMMANDS) {
	app.command(command, async ({ ack, command: cmd }) => {
		const founder = founderForUserId(cmd.user_id);
		if (!founder) {
			// D-40: off-allowlist -> silent. An empty ack produces no
			// visible bot reply; this is as close to "no reply" as
			// Slack's slash-command contract allows (it still requires
			// an ack within 3s or Slack itself shows a timeout error).
			await ack();
			return;
		}
		await ack({
			response_type: "ephemeral",
			text: `\`${command}\` isn't implemented yet — command logic lands in Part 9b (see docs/COMMANDS.md).`,
		});
	});
}

function downloadFile(url, destPath) {
	return new Promise((resolve, reject) => {
		const req = https.get(
			url,
			{ headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } },
			(res) => {
				if (res.statusCode !== 200) {
					reject(new Error(`download failed: HTTP ${res.statusCode}`));
					return;
				}
				const out = fs.createWriteStream(destPath);
				res.pipe(out);
				out.on("finish", () => out.close(resolve));
				out.on("error", reject);
			},
		);
		req.on("error", reject);
	});
}

app.message(async ({ message, client }) => {
	// Only DMs are captures. Ignore channel messages, edits, deletes, bot
	// messages and anything without a plain user text body.
	if (message.channel_type !== "im") return;
	if (message.subtype) return;
	if (!message.user) return;

	const founder = founderForUserId(message.user);
	if (!founder) return; // D-40: silent, no reply, no file

	try {
		const audioFiles = (message.files || []).filter((f) =>
			(f.mimetype || "").startsWith("audio/"),
		);

		if (audioFiles.length > 0) {
			// Voice capture: native-audio transcription via Gemini 3.7
			// Flash (D-36) is command-adjacent logic, out of scope for
			// Part 9's transport-only pass. Save the raw audio so
			// nothing is lost, and leave a placeholder capture line
			// pointing at it for Part 9b to pick up.
			const audioDir = path.join(MINDS_DIR, founder, "captures", "audio");
			fs.mkdirSync(audioDir, { recursive: true });
			for (const f of audioFiles) {
				const destName = `${Date.now()}-${f.name || f.id}`;
				const dest = path.join(audioDir, destName);
				await downloadFile(f.url_private, dest);
				writeCapture(
					founder,
					`[voice note saved to captures/audio/${destName} — transcription pending, see Part 9b]`,
				);
			}
		}

		const text = (message.text || "").trim();
		if (text) {
			writeCapture(founder, text);
		}

		if (audioFiles.length > 0 || text) {
			await client.reactions.add({
				channel: message.channel,
				timestamp: message.ts,
				name: "white_check_mark",
			});
		}
	} catch (err) {
		console.error("capture failed:", err);
	}
});

(async () => {
	await app.start();
	console.log("mill-chat: Slack bot connected (Socket Mode)");

	startBatchCommitLoop((reason) => {
		console.error(`batch commit failed: ${reason}`);
	});

	for (const sig of ["SIGINT", "SIGTERM"]) {
		process.on(sig, async () => {
			console.log(`${sig} received, flushing pending captures before exit`);
			await commitCaptures((reason) =>
				console.error(`final commit failed: ${reason}`),
			);
			process.exit(0);
		});
	}
})();
