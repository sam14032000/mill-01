"use strict";

// Part 18.4–18.7: the single mountable prototype slot behind ngrok on
// 3200. `/proto` only builds; a prototype becomes publicly reachable
// only by an explicit Mount, which takes the one slot. Auto-dismounts
// after a bounded window; a shared URL must never 502 (mount.sh keeps an
// idle placeholder on 3200 whenever nothing real is mounted).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const { IDEAS_DIR, readState, updateState } = require("./ideas");
const { emit } = require("./telemetry");
const { buildEvalEvent } = require("./eval-event");
const { userIdForFounder } = require("./config");

const MOUNT_SH = path.join(os.homedir(), "stack", "sandbox", "mount.sh");
const DEFAULT_MIN = Number(process.env.MILL_MOUNT_DEFAULT_MIN) || 30;
const CAP_MIN = Number(process.env.MILL_MOUNT_CAP_MIN) || 480; // 8h
const WARN_MIN = Number(process.env.MILL_MOUNT_WARN_MIN) || 5;
const NGROK_API = process.env.MILL_NGROK_API || "http://127.0.0.1:4040/api/tunnels";

// in-memory timers for the currently-mounted idea (re-armed on restart
// from state.json, Part 18.6)
const timers = { idea: null, warn: null, expire: null };

function sh(args, opts = {}) {
	return new Promise((resolve) => {
		execFile("bash", [MOUNT_SH, ...args], { timeout: 30_000, ...opts }, (error, stdout, stderr) => {
			resolve({ error, stdout: stdout || "", stderr: stderr || "" });
		});
	});
}

// 18.7: never report a prototype live on assumption -- confirm the tunnel
// via ngrok's Agent API first. Returns the public URL or null.
async function ngrokPublicUrl() {
	try {
		const res = await fetch(NGROK_API, { signal: AbortSignal.timeout(4000) });
		if (!res.ok) return null;
		const data = await res.json();
		const t = (data.tunnels || []).find((x) => (x.public_url || "").startsWith("https://"));
		return t ? t.public_url : null;
	} catch {
		return null;
	}
}

function findMountedIdea() {
	let dirs;
	try {
		dirs = fs.readdirSync(IDEAS_DIR);
	} catch {
		return null;
	}
	for (const id of dirs) {
		const st = readState(id);
		if (st && st.mount && st.mount.container) return st;
	}
	return null;
}

// The entry file of a touch: FILENAME line is stored as the only non-dir
// file in ideas/<id>/proto/<n>/ that isn't output.txt.
function touchEntryFile(id, touchN) {
	const dir = path.join(IDEAS_DIR, id, "proto", String(touchN));
	const files = fs.readdirSync(dir).filter((f) => f !== "output.txt" && !fs.statSync(path.join(dir, f)).isDirectory());
	return files[0] || null;
}

function clearTimers() {
	for (const k of ["warn", "expire"]) {
		if (timers[k]) clearTimeout(timers[k]);
		timers[k] = null;
	}
	timers.idea = null;
}

function armTimers({ id, expiresAt, client, channel, threadTs }) {
	clearTimers();
	timers.idea = id;
	const now = Date.now();
	const msToExpire = Math.max(0, new Date(expiresAt).getTime() - now);
	const msToWarn = msToExpire - WARN_MIN * 60_000;

	if (msToWarn > 0) {
		timers.warn = setTimeout(() => {
			client.chat
				.postMessage({
					channel,
					thread_ts: threadTs,
					text: `⏳ Prototype for \`${id}\` auto-dismounts in ${WARN_MIN} min.`,
					blocks: [
						{ type: "section", text: { type: "mrkdwn", text: `⏳ Prototype for \`${id}\` auto-dismounts in ${WARN_MIN} min.` } },
						{ type: "actions", elements: [{ type: "button", action_id: "proto_extend", text: { type: "plain_text", text: "Extend" }, value: id }] },
					],
				})
				.catch(() => {});
		}, msToWarn);
		timers.warn.unref?.();
	}
	timers.expire = setTimeout(() => {
		dismount({ id, client, channel, threadTs, reason: "auto (window elapsed)" }).catch((e) =>
			console.error(`mount: auto-dismount failed for ${id}: ${e.message}`),
		);
	}, msToExpire);
	timers.expire.unref?.();
}

async function dismount({ id, client, channel, threadTs, reason }) {
	await sh(["down"]);
	const st = readState(id);
	if (st && st.mount) updateState(id, { mount: null });
	clearTimers();
	if (client && channel) {
		await client.chat
			.postMessage({ channel, thread_ts: threadTs, text: `🔻 Prototype for \`${id}\` dismounted — ${reason}. The slot is free.` })
			.catch(() => {});
	}
	emit(buildEvalEvent({ stage: "mount", ideaId: id, founder: null, status: "ok", reasonCode: "dismount" }));
}

async function mount({ id, touchN, byFounder, minutes, client, channel, threadTs }) {
	const requested = Math.min(minutes || DEFAULT_MIN, CAP_MIN);
	const existing = findMountedIdea();
	if (existing && existing.id !== id) {
		// 18.5 contention: report, offer take-over, do not queue or evict.
		const m = existing.mount;
		const leftMin = Math.max(0, Math.round((new Date(m.expires_at).getTime() - Date.now()) / 60000));
		await client.chat.postMessage({
			channel,
			thread_ts: threadTs,
			text: `The mount slot is taken by \`${existing.id}\` (${m.mounted_by}), ~${leftMin} min left.`,
			blocks: [
				{ type: "section", text: { type: "mrkdwn", text: `The single mount slot is taken by \`${existing.id}\` (mounted by *${m.mounted_by}*, ~${leftMin} min left). Not queuing, not auto-evicting.` } },
				{ type: "actions", elements: [{ type: "button", action_id: "proto_takeover", style: "danger", text: { type: "plain_text", text: "Take over" }, value: `${id}::${touchN}::${requested}` }] },
			],
		});
		return { ok: false, reason: "contended", by: existing.id };
	}

	const entry = touchEntryFile(id, touchN);
	if (!entry) {
		await client.chat.postMessage({ channel, thread_ts: threadTs, text: `Can't mount \`${id}\` touch ${touchN}: no artifact file found.` }).catch(() => {});
		return { ok: false, reason: "no_entry" };
	}
	const scratch = fs.mkdtempSync(path.join(os.homedir(), "scratch", "mnt-"));
	fs.copyFileSync(path.join(IDEAS_DIR, id, "proto", String(touchN), entry), path.join(scratch, entry));
	fs.chmodSync(scratch, 0o777);

	const up = await sh(["up", scratch, entry]);
	if (up.error) {
		await client.chat.postMessage({ channel, thread_ts: threadTs, text: `Mount failed for \`${id}\`: ${(up.stderr || up.error.message).slice(0, 300)}` }).catch(() => {});
		return { ok: false, reason: "mount_sh_failed" };
	}

	// 18.7: verify before reporting.
	const publicUrl = await ngrokPublicUrl();
	const localOk = await new Promise((r) => {
		fetch("http://127.0.0.1:3200/", { signal: AbortSignal.timeout(4000) }).then((x) => r(x.ok)).catch(() => r(false));
	});

	const mountedAt = new Date();
	const expiresAt = new Date(mountedAt.getTime() + requested * 60_000);
	updateState(id, {
		mount: {
			touch: touchN,
			mounted_at: mountedAt.toISOString(),
			mounted_by: byFounder,
			expires_at: expiresAt.toISOString(),
			container: "mill-proto-mount",
		},
	});
	armTimers({ id, expiresAt, client, channel, threadTs });

	const creds = `\`${process.env.PROTO_BASIC_AUTH_USER || "mill"}\` / \`${process.env.PROTO_BASIC_AUTH_PASS || "(see password manager)"}\``;
	const urlLine = publicUrl
		? `URL: ${publicUrl}  (basic auth: ${creds})`
		: `⚠️ ngrok tunnel not confirmed via the Agent API — container is up locally on 3200 but I can't verify a public URL. Not reporting one on assumption (18.7).`;
	await client.chat.postMessage({
		channel,
		thread_ts: threadTs,
		text: `🔺 Mounted \`${id}\` touch ${touchN} (${entry}) for ${requested} min.\n${urlLine}\nLocal check: ${localOk ? "responding" : "NOT responding — the prototype may not listen on :8080"}`,
		blocks: [
			{ type: "section", text: { type: "mrkdwn", text: `🔺 Mounted \`${id}\` touch ${touchN} (\`${entry}\`) for *${requested} min*.\n${urlLine}\nLocal check: ${localOk ? "responding ✅" : "*not responding* — does it listen on :8080?"}` } },
			{
				type: "actions",
				elements: [
					{ type: "button", action_id: "proto_dismount", text: { type: "plain_text", text: "Dismount" }, value: id },
					{ type: "button", action_id: "proto_extend", text: { type: "plain_text", text: "Extend" }, value: id },
				],
			},
		],
	});
	emit(buildEvalEvent({ stage: "mount", ideaId: id, founder: byFounder, status: "ok", reasonCode: publicUrl ? "mounted" : "mounted_no_tunnel" }));
	return { ok: true, publicUrl, expiresAt };
}

async function extend({ id, client, channel, threadTs }) {
	const st = readState(id);
	if (!st || !st.mount) {
		await client.chat.postMessage({ channel, thread_ts: threadTs, text: `\`${id}\` isn't mounted.` }).catch(() => {});
		return;
	}
	const mountedAt = new Date(st.mount.mounted_at).getTime();
	const capAt = mountedAt + CAP_MIN * 60_000;
	const newExpiry = Math.min(Date.now() + DEFAULT_MIN * 60_000, capAt);
	if (newExpiry <= Date.now() + 60_000) {
		await client.chat.postMessage({ channel, thread_ts: threadTs, text: `Can't extend \`${id}\` — the ${CAP_MIN / 60}h cap is reached. Dismount and re-mount if you're still working.` }).catch(() => {});
		return;
	}
	updateState(id, { mount: { ...st.mount, expires_at: new Date(newExpiry).toISOString() } });
	armTimers({ id, expiresAt: new Date(newExpiry).toISOString(), client, channel, threadTs });
	await client.chat.postMessage({ channel, thread_ts: threadTs, text: `Extended \`${id}\` — auto-dismount now ~${new Date(newExpiry).toISOString().slice(11, 16)} UTC.` }).catch(() => {});
}

// Part 18.6: on bot start, reconcile stored mount state against the
// actually-running container. Trust `docker`/`mount.sh status`, not
// state.json.
async function reconcileOnStartup(client) {
	const st = findMountedIdea();
	const status = await sh(["status"]);
	let running = false;
	try {
		running = JSON.parse(status.stdout.trim() || "{}").mounted === true;
	} catch {
		running = false;
	}

	if (st && running) {
		const expired = new Date(st.mount.expires_at).getTime() <= Date.now();
		if (expired) {
			console.log(`mount: reconcile -- ${st.id} was mounted but its window elapsed; dismounting`);
			await dismount({ id: st.id, client, channel: st.channel_id, threadTs: st.threads?.prototype, reason: "auto (window elapsed while bot was down)" });
		} else {
			console.log(`mount: reconcile -- ${st.id} still mounted, re-arming timers`);
			armTimers({ id: st.id, expiresAt: st.mount.expires_at, client, channel: st.channel_id, threadTs: st.threads?.prototype });
		}
		return { state: "mounted", id: st.id, running: true, expired };
	}
	if (st && !running) {
		console.log(`mount: reconcile -- ${st.id} state says mounted but no container is running; clearing state`);
		updateState(st.id, { mount: null });
		await sh(["idle"]);
		return { state: "stale_cleared", id: st.id, running: false };
	}
	if (!st && running) {
		console.log("mount: reconcile -- a container is running but no idea claims it; leaving it (manual)");
		return { state: "orphan_container", running: true };
	}
	await sh(["idle"]);
	return { state: "idle", running: false };
}

module.exports = {
	mount,
	dismount,
	extend,
	reconcileOnStartup,
	findMountedIdea,
	ngrokPublicUrl,
	touchEntryFile,
	DEFAULT_MIN,
	CAP_MIN,
	WARN_MIN,
};
