"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createTwoFilesPatch } = require("diff");

const { activeFounders, userIdForFounder, channelId } = require("./config");
const { callFlash } = require("./llm");
const { readCaptures, readProfile, MINDS_DIR } = require("./context");
const { commitAndPush } = require("./git");
const { emit } = require("./telemetry");
const { buildEvalEvent } = require("./eval-event");

const MODEL = "flash-fast";
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Verbatim from docs/COMMANDS.md's profile evolution system prompt.
const PROFILE_SYSTEM_PROMPT = [
	"Update this profile based on the week's evidence. The profile records **how this founder fails** — what they over-weight, which frames they default to, what they killed and why.",
	"It does not record what they believe. A profile that reflects beliefs back is an echo chamber and defeats its purpose.",
	"Propose only changes the week's evidence supports. Small diffs are correct.",
].join("\n");

// docs/COMMANDS.md doesn't give a verbatim prompt for shared/dynamics.md
// (only "updates on the same run, posted to #mill-ideas, approved by any
// founder") -- this mirrors D-26/D-30's spirit for the shared file, per
// D-27's framing of dynamics.md as "where the three of you converge too
// fast," not a summary of the week.
const DYNAMICS_SYSTEM_PROMPT = [
	"Update this shared file based on the week's evidence across all three founders. It records where all three converge too fast -- shared blind spots, not a summary of what happened.",
	"It does not record what any of them believe. Propose only changes the week's evidence supports. Small diffs are correct.",
].join("\n");

function readGraveyard(founder) {
	try {
		return fs.readFileSync(path.join(MINDS_DIR, founder, "graveyard.md"), "utf8");
	} catch {
		return "";
	}
}

function readDynamics() {
	try {
		return fs.readFileSync(path.join(MINDS_DIR, "shared", "dynamics.md"), "utf8");
	} catch {
		return "";
	}
}

function pendingDiffPath(kind, id) {
	const dir = path.join(MINDS_DIR, kind === "profile" ? id : "shared", ".pending-diffs");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function makeDiffId() {
	return crypto.randomBytes(4).toString("hex");
}

function unifiedDiff(label, oldContent, newContent) {
	return createTwoFilesPatch(label, label, oldContent, newContent, "current", "proposed");
}

// Gemini 3.x can reason over a near-empty prompt (sparse/no captures) and
// then legitimately emit no visible text -- finish_reason "stop", not
// "length", so this isn't the reasoning-budget-exhaustion case, it's the
// model choosing not to answer. llm.js correctly throws on this for every
// other command, where an empty reply is a real failure to surface. Here
// it's a valid outcome: D-30's "small diffs are correct" implicitly allows
// "no diff" for a week with nothing to go on, so this is caught and folded
// into the same changed:false path a genuinely-unchanged proposal takes.
async function callFlashForDiff(messages) {
	try {
		return await callFlash(messages, { model: MODEL, maxTokens: 2048 });
	} catch (err) {
		if (String(err?.message || "").endsWith("call returned no content")) {
			return { content: null, usage: undefined, costUsd: err.costUsd ?? 0, cacheHit: err.cacheHit ?? false };
		}
		throw err;
	}
}

// Generates a proposed profile.md diff for one founder from the last 7
// days of their captures, their graveyard, and the current profile.
// Returns null if the model proposes no change (identical content) --
// D-30's "small diffs are correct" includes "no diff" as a valid answer.
async function generateProfileDiff(founder) {
	const currentProfile = readProfile(founder);
	const captures = readCaptures(founder, { maxDays: 7 });
	const graveyard = readGraveyard(founder);

	const messages = [
		{ role: "system", content: PROFILE_SYSTEM_PROMPT },
		{
			role: "user",
			content: [
				`Current profile.md:\n${currentProfile || "(empty -- no profile recorded yet)"}`,
				`This week's captures:\n${captures.length ? captures.join("\n") : "(none)"}`,
				`Graveyard (killed ideas + reasons):\n${graveyard || "(empty)"}`,
				"Return only the complete new profile.md content. No preamble, no explanation, no diff markup -- just the full proposed file.",
			].join("\n\n"),
		},
	];

	const t0 = Date.now();
	const { content, usage, costUsd, cacheHit } = await callFlashForDiff(messages);
	const wallClockS = (Date.now() - t0) / 1000;
	const tokensIn = usage?.prompt_tokens ?? 0;
	const tokensOut = usage?.completion_tokens ?? 0;
	const cacheHitRatio = cacheHit ? 1 : 0;

	if (content === null) {
		return { changed: false, tokensIn, tokensOut, costUsd: costUsd ?? 0, cacheHitRatio, wallClockS };
	}

	const newContent = content.trim();
	if (newContent === currentProfile.trim()) {
		return { changed: false, tokensIn, tokensOut, costUsd, cacheHitRatio, wallClockS };
	}

	return {
		changed: true,
		oldContent: currentProfile,
		newContent: `${newContent}\n`,
		diff: unifiedDiff(`minds/${founder}/profile.md`, currentProfile, newContent),
		tokensIn,
		tokensOut,
		costUsd,
		cacheHitRatio,
		wallClockS,
	};
}

// Same shape, for shared/dynamics.md across all three founders' weekly
// activity combined.
async function generateDynamicsDiff() {
	const currentDynamics = readDynamics();
	const founders = activeFounders();
	const combinedCaptures = founders
		.map((f) => {
			const caps = readCaptures(f, { maxDays: 7 });
			return `${f}:\n${caps.length ? caps.join("\n") : "(none)"}`;
		})
		.join("\n\n");

	const messages = [
		{ role: "system", content: DYNAMICS_SYSTEM_PROMPT },
		{
			role: "user",
			content: [
				`Current shared/dynamics.md:\n${currentDynamics || "(empty -- nothing recorded yet)"}`,
				`This week's captures, all three founders:\n${combinedCaptures}`,
				"Return only the complete new dynamics.md content. No preamble, no explanation, no diff markup -- just the full proposed file.",
			].join("\n\n"),
		},
	];

	const t0 = Date.now();
	const { content, usage, costUsd, cacheHit } = await callFlashForDiff(messages);
	const wallClockS = (Date.now() - t0) / 1000;
	const tokensIn = usage?.prompt_tokens ?? 0;
	const tokensOut = usage?.completion_tokens ?? 0;
	const cacheHitRatio = cacheHit ? 1 : 0;

	if (content === null) {
		return { changed: false, tokensIn, tokensOut, costUsd: costUsd ?? 0, cacheHitRatio, wallClockS };
	}

	const newContent = content.trim();
	if (newContent === currentDynamics.trim()) {
		return { changed: false, tokensIn, tokensOut, costUsd, cacheHitRatio, wallClockS };
	}

	return {
		changed: true,
		oldContent: currentDynamics,
		newContent: `${newContent}\n`,
		diff: unifiedDiff("minds/shared/dynamics.md", currentDynamics, newContent),
		tokensIn,
		tokensOut,
		costUsd,
		cacheHitRatio,
		wallClockS,
	};
}

// Persists a proposed diff so the approve/reject button click (handled
// later, by the always-on bot process, possibly minutes or hours after
// this posts) has something to read. Never auto-applied (D-30) --
// writing this file does not touch profile.md/dynamics.md itself.
function savePendingDiff(kind, id, diffRecord) {
	const diffId = makeDiffId();
	const dir = pendingDiffPath(kind, id);
	fs.writeFileSync(
		path.join(dir, `${diffId}.json`),
		JSON.stringify({ kind, id, ...diffRecord, createdAt: new Date().toISOString() }, null, 2),
		"utf8",
	);
	return diffId;
}

function readPendingDiff(kind, id, diffId) {
	try {
		return JSON.parse(fs.readFileSync(path.join(pendingDiffPath(kind, id), `${diffId}.json`), "utf8"));
	} catch {
		return null;
	}
}

function deletePendingDiff(kind, id, diffId) {
	try {
		fs.unlinkSync(path.join(pendingDiffPath(kind, id), `${diffId}.json`));
	} catch {
		/* already gone */
	}
}

// action_id encodes kind (profile|dynamics) and decision (approve|reject);
// value encodes "kind:id:diffId" so the button click alone carries
// everything the handler needs, without a separate lookup step.
function actionValue(kind, id, diffId) {
	return `${kind}:${id}:${diffId}`;
}

function parseActionValue(value) {
	const [kind, id, diffId] = value.split(":");
	return { kind, id, diffId };
}

async function postProfileDiffForReview(client, founder, result) {
	const userId = userIdForFounder(founder);
	if (!userId) {
		console.error(`profile-evolution: no Slack user id for founder ${founder}, cannot DM`);
		return;
	}
	const diffId = savePendingDiff("profile", founder, result);
	const { channel } = await client.conversations.open({ users: userId });
	await client.chat.postMessage({
		channel: channel.id,
		text: `Weekly profile diff for review:\n\`\`\`\n${result.diff.slice(0, 2900)}\n\`\`\``,
		blocks: [
			{
				type: "section",
				text: { type: "mrkdwn", text: `\`\`\`\n${result.diff.slice(0, 2900)}\n\`\`\`` },
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Approve" },
						style: "primary",
						action_id: "profile_diff_approve",
						value: actionValue("profile", founder, diffId),
					},
					{
						type: "button",
						text: { type: "plain_text", text: "Reject" },
						style: "danger",
						action_id: "profile_diff_reject",
						value: actionValue("profile", founder, diffId),
					},
				],
			},
		],
	});
}

async function postDynamicsDiffForReview(client, result) {
	const millChannel = channelId("mill");
	if (!millChannel) {
		console.error("profile-evolution: SLACK_CHANNEL_MILL not configured, cannot post dynamics diff");
		return;
	}
	const diffId = savePendingDiff("dynamics", "shared", result);
	await client.chat.postMessage({
		channel: millChannel,
		text: `Weekly shared/dynamics.md diff for review (any founder can approve/reject):\n\`\`\`\n${result.diff.slice(0, 2900)}\n\`\`\``,
		blocks: [
			{
				type: "section",
				text: { type: "mrkdwn", text: `\`\`\`\n${result.diff.slice(0, 2900)}\n\`\`\`` },
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Approve" },
						style: "primary",
						action_id: "profile_diff_approve",
						value: actionValue("dynamics", "shared", diffId),
					},
					{
						type: "button",
						text: { type: "plain_text", text: "Reject" },
						style: "danger",
						action_id: "profile_diff_reject",
						value: actionValue("dynamics", "shared", diffId),
					},
				],
			},
		],
	});
}

// Runs the whole weekly job: one profile diff per active founder, one
// shared dynamics diff. Called by the Sunday 09:30 cron entry point.
async function runWeeklyProfileEvolution(client) {
	for (const founder of activeFounders()) {
		try {
			const result = await generateProfileDiff(founder);
			emit(
				buildEvalEvent({
					stage: "profile_evolution",
					model: MODEL,
					founder,
					tokensIn: result.tokensIn,
					tokensOut: result.tokensOut,
					costUsd: result.costUsd,
					cacheHitRatio: result.cacheHitRatio ?? 0,
					wallClockS: result.wallClockS,
					status: result.changed ? "ok" : "no_change",
				}),
			);
			if (result.changed) {
				await postProfileDiffForReview(client, founder, result);
			}
		} catch (err) {
			console.error(`profile-evolution: failed for ${founder}:`, err);
			emit(
				buildEvalEvent({
					stage: "profile_evolution",
					founder,
					status: "failed",
					reasonCode: "generation_failed",
				}),
			);
		}
	}

	try {
		const result = await generateDynamicsDiff();
		emit(
			buildEvalEvent({
				stage: "dynamics_evolution",
				model: MODEL,
				founder: null,
				tokensIn: result.tokensIn,
				tokensOut: result.tokensOut,
				costUsd: result.costUsd,
				cacheHitRatio: result.cacheHitRatio ?? 0,
				wallClockS: result.wallClockS,
				status: result.changed ? "ok" : "no_change",
			}),
		);
		if (result.changed) {
			await postDynamicsDiffForReview(client, result);
		}
	} catch (err) {
		console.error("profile-evolution: dynamics generation failed:", err);
		emit(
			buildEvalEvent({
				stage: "dynamics_evolution",
				founder: null,
				status: "failed",
				reasonCode: "generation_failed",
			}),
		);
	}
}

// Handles the approve/reject button click. D-30: never auto-applied --
// this is the only code path that writes profile.md/dynamics.md content
// proposed by a model, and it only runs on an explicit human click.
async function handleDiffDecision({ action, body, client }) {
	const { kind, id, diffId } = parseActionValue(action.value);
	const approved = action.action_id === "profile_diff_approve";
	const pending = readPendingDiff(kind, id, diffId);

	if (!pending) {
		await client.chat.postMessage({
			channel: body.channel?.id || body.user.id,
			text: "That diff is no longer pending (already decided, or expired).",
		});
		return;
	}

	const targetPath =
		kind === "profile"
			? path.join(MINDS_DIR, id, "profile.md")
			: path.join(MINDS_DIR, "shared", "dynamics.md");
	const relPath = path.relative(REPO_ROOT, targetPath);

	if (approved) {
		fs.writeFileSync(targetPath, pending.newContent, "utf8");
		await commitAndPush(
			[relPath],
			`${kind === "profile" ? `${id}'s profile.md` : "shared/dynamics.md"}: weekly diff approved by ${body.user.id}`,
			(reason) => console.error(`git commit/push failed for ${relPath}: ${reason}`),
		);
	}
	// Rejected diffs are logged, not retried (D-30) -- the emit() call
	// below is that log; no other action needed for a rejection.

	deletePendingDiff(kind, id, diffId);

	emit(
		buildEvalEvent({
			stage: kind === "profile" ? "profile_evolution" : "dynamics_evolution",
			founder: kind === "profile" ? id : null,
			status: approved ? "approved" : "rejected",
		}),
	);

	await client.chat.postMessage({
		channel: body.channel?.id || body.user.id,
		text: approved ? `Applied to \`${relPath}\`.` : `Rejected. \`${relPath}\` unchanged.`,
	});
}

module.exports = {
	generateProfileDiff,
	generateDynamicsDiff,
	runWeeklyProfileEvolution,
	handleDiffDecision,
};
