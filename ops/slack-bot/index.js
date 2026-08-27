"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { App } = require("@slack/bolt");
const https = require("node:https");

const config = require("./config");
const { founderForUserId } = config;
const { writeCapture, MINDS_DIR } = require("./capture");
const { startBatchCommitLoop, commitCaptures } = require("./git-batch");
const { handleAttackCommand } = require("./commands/attack");
const { handleThinkCommand } = require("./commands/think");
const { handleCrossCommand } = require("./commands/cross");
const { handleBlindspotCommand } = require("./commands/blindspot");
const { handleThemesCommand } = require("./commands/themes");
const { handleTestCommand } = require("./commands/test");
const { handleAuditCommand } = require("./commands/audit");
const { handleProtoCommand } = require("./commands/proto");
const { handleChatCommand } = require("./commands/chat");
const { handleSearchCommand } = require("./commands/search");
const { handleThreadMessage } = require("./thread-wait");
const { handleChatTurn } = require("./chat-turn");
const chatSession = require("./chat-session");
const { PROMOTE_ACTION_ID } = require("./promote-button");
const { promoteChat } = require("./promotion");
const { handleProjectUpload } = require("./documents");
const { runWeeklyProfileEvolution, handleDiffDecision } = require("./profile-evolution");
const { startWeeklyScheduler } = require("./weekly-scheduler");
const { startNightlyScheduler } = require("./nightly-capture");
const { startSocketHealth } = require("./socket-health");

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

// Inbound-event log, kept permanently. Before this line there was zero
// logging of what Slack delivered, which is why the 2026-08-27 wedge
// (socket alive, events silently dropped) could not be diagnosed without
// live instrumentation. One line per dispatched request; no message
// content, only shape (type, channel kind, user, text length).
app.use(async ({ body, next }) => {
	try {
		const t = body?.type || body?.event?.type || "?";
		const ev = body?.event || {};
		console.log(
			`[inbound] type=${t} event_type=${ev.type || "-"} subtype=${ev.subtype || "-"} channel_type=${ev.channel_type || "-"} channel=${ev.channel || body?.channel_id || "-"} user=${ev.user || body?.user_id || "-"} command=${body?.command || "-"} text_len=${(ev.text || body?.text || "").length}`,
		);
	} catch (err) {
		console.log(`[inbound] (failed to introspect): ${err.message}`);
	}
	await next();
});

// All eight slash commands defined in Slack app config (Part 9.1) are
// now implemented, in the build order docs/COMMANDS.md/D-41 specify.
const STUBBED_COMMANDS = [];

app.command("/attack", handleAttackCommand);
app.command("/think", handleThinkCommand);
app.command("/cross", handleCrossCommand);
app.command("/test", handleTestCommand);
app.command("/audit", handleAuditCommand);
app.command("/proto", handleProtoCommand);
app.command("/blindspot", handleBlindspotCommand);
app.command("/themes", handleThemesCommand);
app.command("/chat", handleChatCommand);
app.command("/search", handleSearchCommand);

for (const command of STUBBED_COMMANDS) {
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

// D-30: never auto-applied -- these are the only two entry points that
// write a model-proposed profile.md/dynamics.md change, and both
// require an explicit human button click to reach them at all.
app.action("profile_diff_approve", async ({ ack, action, body, client }) => {
	await ack();
	await handleDiffDecision({ action, body, client }).catch((err) =>
		console.error("profile_diff_approve failed:", err),
	);
});
app.action("profile_diff_reject", async ({ ack, action, body, client }) => {
	await ack();
	await handleDiffDecision({ action, body, client }).catch((err) =>
		console.error("profile_diff_reject failed:", err),
	);
});

// "Start a project from this idea" (build-guide-projects Part 15). The
// button's value is the chat session's thread_ts.
app.action(PROMOTE_ACTION_ID, async ({ ack, body, client }) => {
	await ack();
	const threadTs = body.actions?.[0]?.value;
	const session = chatSession.getSession(threadTs);
	const channel = body.channel?.id;
	if (!session) {
		if (channel) {
			await client.chat
				.postMessage({
					channel,
					thread_ts: threadTs,
					text: "_Can't promote — I've lost the state for this chat (a restart, or it was already promoted). Start a fresh `/chat` if you need to._",
				})
				.catch(() => {});
		}
		return;
	}
	await promoteChat({ session, client, triggeredByUserId: body.user?.id }).catch((err) =>
		console.error("promote_chat action failed:", err),
	);
});

app.message(async ({ message, client }) => {
	// A pending /test field-evidence wait takes priority over anything
	// else a message could be -- if consumed here, it's not a capture
	// even if it happened to arrive in a DM.
	if (handleThreadMessage(message)) return;

	// A file uploaded into a project channel is a document (Part 17).
	if (message.subtype === "file_share" && (await handleProjectUpload({ message, client }))) return;

	// A message in a #chats session thread is a conversational turn, not
	// a capture (build-guide-projects 14.3 -- these paths never collapse).
	if (await handleChatTurn({ message, client })) return;

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

	// Turn a wedged Socket Mode connection into a dead process so systemd
	// (Restart=always) rebuilds it -- see socket-health.js for the full
	// rationale (2026-08-27 reboot: socket alive, events silently dropped).
	startSocketHealth({ app });

	// #chats session state is mirrored to disk (outside the repo) so a
	// restart doesn't lose raw thinking -- reload it (build-guide-projects
	// Part 14.2/14.7).
	const restored = chatSession.loadAll();
	console.log(`chat-session: restored ${restored} session(s) from disk`);

	startBatchCommitLoop((reason) => {
		console.error(`batch commit failed: ${reason}`);
	});

	// 20:00 UTC (01:30 IST): append each founder's own messages from
	// unpromoted chats to their captures file (Part 14.7). In-process, not
	// cron, for the same reason weekly profile evolution is.
	startNightlyScheduler((reason) => console.error(`nightly chat capture failed: ${reason}`));

	// Sunday 09:30 IST (04:00 UTC), D-30: proposes profile/dynamics diffs,
	// never applies them -- see profile-evolution.js and the
	// profile_diff_approve/reject action handlers above.
	startWeeklyScheduler(
		() => runWeeklyProfileEvolution(app.client),
		(reason) => console.error(`weekly profile evolution failed: ${reason}`),
	);

	// Reload the allowlist/channel map from disk on SIGHUP, so adding a
	// founder (or fixing a channel id) later is just editing
	// ~/.config/mill/env and `systemctl kill -s HUP mill-chat` -- no code
	// change, no full restart needed. A plain `systemctl restart` also
	// picks up the change, since config.load() runs at require time too.
	process.on("SIGHUP", () => {
		console.log("SIGHUP received, reloading config");
		config.load();
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
