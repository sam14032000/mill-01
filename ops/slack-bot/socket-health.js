"use strict";

// Socket Mode wedge detection.
//
// Why this exists: after the 2026-08-27 reboot the bot process stayed
// `active` with a half-open WebSocket for ~5 hours -- inbound message.im
// events were silently dropped (captures lost) while Slack retried slash
// commands (duplicate #mill-ideas posts). `Restart=always` never fired
// because the process never exited. The rule this module enforces: a
// wedged socket must become a dead process, so systemd rebuilds it.
//
// Three independent triggers, any one of which exits the process with a
// non-zero code (RestartSec=10 in the unit brings it back):
//
//   1. No WebSocket pong for PONG_STALE_MS. This is the fast, precise
//      wedge signal -- @slack/socket-mode pings Slack every ~1.6s on a
//      healthy connection regardless of founder activity, so stale pongs
//      mean the socket is genuinely dead, not just quiet.
//   2. More than MAX_CONSECUTIVE_PING_MISSES pings sent with no pong in
//      between -- mirrors socket-mode's own internal `pingAttemptCount`
//      check, but ours ends the process instead of just reconnecting.
//   3. No inbound Slack event for INBOUND_SILENCE_MS. A quiet overnight
//      workspace legitimately produces zero events for hours, so this
//      one does not blindly exit: it runs a live `auth.test` first and
//      only exits if that probe also fails. It's the catch-all for a
//      wedge where pongs still flow but Bolt stops dispatching events.
//
// Also maintains a heartbeat file (mtime + a status line) that
// ops/healthcheck.sh alerts on when stale -- so "bot is wedged" reaches
// Slack even if all three triggers somehow miss.

const fs = require("node:fs");
const diagnostics = require("node:diagnostics_channel");

const PONG_STALE_MS = Number(process.env.MILL_SOCKET_PONG_STALE_MS) || 90_000;
const INBOUND_SILENCE_MS =
	Number(process.env.MILL_SOCKET_SILENCE_MS) || 15 * 60_000;
const MAX_CONSECUTIVE_PING_MISSES =
	Number(process.env.MILL_SOCKET_MAX_PING_MISSES) || 3;
const CHECK_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_FILE =
	process.env.MILL_HEARTBEAT_FILE || "/home/agent/logs/mill-chat.heartbeat";

function startSocketHealth({ app, onExit } = {}) {
	const exit = onExit || ((code) => process.exit(code));

	let lastInboundAt = Date.now();
	let lastPongAt = Date.now();
	let pingsSinceLastPong = 0;
	let silenceProbeInFlight = false;
	let dead = false;

	function writeHeartbeat(note) {
		const now = Date.now();
		const line =
			`${new Date(now).toISOString()} ${note || "ok"} ` +
			`inbound_age_s=${Math.floor((now - lastInboundAt) / 1000)} ` +
			`pong_age_s=${Math.floor((now - lastPongAt) / 1000)}\n`;
		fs.writeFile(HEARTBEAT_FILE, line, (err) => {
			if (err) console.error(`[socket-health] heartbeat write failed: ${err.message}`);
		});
	}

	function die(reason) {
		if (dead) return;
		dead = true;
		console.error(
			`[socket-health] ${reason} — exiting (systemd Restart=always will rebuild the connection)`,
		);
		writeHeartbeat(`DEAD ${reason}`);
		// Give the log line a tick to flush before the process goes.
		setTimeout(() => exit(1), 100);
	}

	// --- ping/pong accounting, via the same undici diagnostics channels
	//     @slack/socket-mode subscribes to internally ---
	diagnostics.subscribe("undici:websocket:pong", () => {
		lastPongAt = Date.now();
		pingsSinceLastPong = 0;
	});
	diagnostics.subscribe("undici:websocket:ping", () => {
		pingsSinceLastPong += 1;
		if (pingsSinceLastPong > MAX_CONSECUTIVE_PING_MISSES) {
			die(`${pingsSinceLastPong} consecutive pings with no pong`);
		}
	});

	// --- inbound Slack traffic proves the connection is delivering ---
	app.use(async ({ next }) => {
		lastInboundAt = Date.now();
		writeHeartbeat("event");
		await next();
	});

	// --- connection lifecycle (best-effort; timers work regardless) ---
	const client = app.receiver && app.receiver.client;
	if (client && typeof client.on === "function") {
		client.on("connected", () => {
			lastPongAt = Date.now();
			lastInboundAt = Date.now();
			pingsSinceLastPong = 0;
			console.log("[socket-health] socket connected");
			writeHeartbeat("connected");
		});
		client.on("disconnected", () =>
			console.warn("[socket-health] socket reported disconnected"),
		);
		client.on("reconnecting", () =>
			console.warn("[socket-health] socket reconnecting"),
		);
	} else {
		console.warn(
			"[socket-health] could not reach SocketModeClient; lifecycle logs disabled, watchdog timers still active",
		);
	}

	async function onInboundSilence(inboundAgeS) {
		if (silenceProbeInFlight) return;
		silenceProbeInFlight = true;
		try {
			await app.client.auth.test();
			console.warn(
				`[socket-health] ${inboundAgeS}s with no inbound event, but auth.test succeeded — connection is just idle, staying up`,
			);
			lastInboundAt = Date.now(); // reset so we re-probe in another INBOUND_SILENCE_MS, not every tick
		} catch (err) {
			die(
				`no inbound event for ${inboundAgeS}s and auth.test failed (${err?.message || err})`,
			);
		} finally {
			silenceProbeInFlight = false;
		}
	}

	const checkTimer = setInterval(() => {
		if (dead) return;
		const now = Date.now();
		const pongAgeS = Math.floor((now - lastPongAt) / 1000);
		const inboundAgeS = Math.floor((now - lastInboundAt) / 1000);

		if (now - lastPongAt > PONG_STALE_MS) {
			die(`no websocket pong for ${pongAgeS}s (limit ${PONG_STALE_MS / 1000}s)`);
			return;
		}
		if (now - lastInboundAt > INBOUND_SILENCE_MS) {
			void onInboundSilence(inboundAgeS);
		}
	}, CHECK_INTERVAL_MS);
	if (checkTimer.unref) checkTimer.unref();

	const hbTimer = setInterval(() => writeHeartbeat("ok"), HEARTBEAT_INTERVAL_MS);
	if (hbTimer.unref) hbTimer.unref();

	writeHeartbeat("startup");
	console.log(
		`[socket-health] watchdog armed (pong_stale=${PONG_STALE_MS / 1000}s, ` +
			`inbound_silence=${INBOUND_SILENCE_MS / 1000}s, max_ping_misses=${MAX_CONSECUTIVE_PING_MISSES}, ` +
			`heartbeat=${HEARTBEAT_FILE})`,
	);

	return { die, writeHeartbeat };
}

module.exports = { startSocketHealth, HEARTBEAT_FILE };
