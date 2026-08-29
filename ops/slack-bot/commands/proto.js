"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { founderForUserId, channelId } = require("../config");
const { callFlash } = require("../llm");
const { ideaExists, readState, updateState, IDEAS_DIR } = require("../ideas");
const { runInSandbox } = require("../sandbox");
const { commitAndPush } = require("../git");
const { commandDestination, ensureStageThread } = require("../chat-session");
const { postNeedsProject } = require("../promotion");
const { upsertStateCard } = require("../state-card");
const { postResult } = require("../reply");
const { DEFAULT_MIN: MOUNT_DEFAULT_MIN } = require("../mount");
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");

const MODEL = "flash-fast";
const STAGE = "proto";
const TOUCH_CAP = 5;

// Phase 2: an executable artifact is built, run in the sandbox, and if it
// exits non-zero the model is given the error and asked to fix it, then
// re-run -- autonomously, up to this many attempts. These are BUILD
// iterations, not touches: a touch is the founder asking for another
// artifact (capped at 5, TOUCH_CAP); a build iteration is the loop
// getting one artifact to run. All inside the same Part 10 sandbox
// contract -- no new execution surface (D-06 unchanged).
const BUILD_MAX = Number(process.env.MILL_PROTO_BUILD_ITERS) || 3;

// Verbatim from docs/COMMANDS.md's /proto system prompt.
const SYSTEM_PROMPT = [
	"Build the smallest artifact that tests this one assumption. Default to non-code — landing page, mock flow, fake pricing table, one-pager. Single file.",
	"Only write executable code if the assumption is technical.",
	"This will be deleted. Do not build for durability.",
].join("\n");

// docs/COMMANDS.md doesn't specify an output format for the artifact
// itself (unlike /attack's ASSUMPTION:/TOO_VAGUE: markers) -- this
// instruction exists only so the response can be parsed and saved to a
// real filename; it doesn't change what the model is asked to build.
const OUTPUT_FORMAT_INSTRUCTION =
	'Output format: the first line must be exactly "FILENAME: <name.ext>" naming a single file (choose the extension yourself -- .html/.md for non-code, .py/.js/.sh only if the assumption is technical), then a blank line, then the complete file content and nothing else. No explanation before or after.';

// Extensions that get executed in the Part 10 sandbox after being
// written -- anything else is an artifact only (landing page, pricing
// table, etc), per "Only write executable code if the assumption is
// technical."
const EXECUTORS = {
	".py": (filename) => `python3 /scratch/${filename}`,
	".js": (filename) => `node /scratch/${filename}`,
	".sh": (filename) => `bash /scratch/${filename}`,
};

function parseProtoResponse(text) {
	const match = text.match(/^FILENAME:\s*(\S+)\s*\n\n([\s\S]+)$/);
	if (!match) return null;
	const filename = match[1].trim();
	// No path separators -- this is a filename, not a path, and nothing
	// here should be able to write outside the touch's own directory.
	if (filename.includes("/") || filename.includes("..")) return null;
	return { filename, content: match[2] };
}

const FIX_PROMPT = (assumption, filename, fileContent, command, exitCode, stderr) =>
	[
		`This artifact was built to test the assumption: ${assumption}`,
		`It was run in a locked-down sandbox as: ${command}`,
		`It exited with code ${exitCode}. stderr:`,
		"```",
		stderr.slice(-2000),
		"```",
		"",
		`Current \`${filename}\`:`,
		"```",
		fileContent,
		"```",
		"",
		`Return the corrected file in the same format: first line exactly "FILENAME: ${filename}", a blank line, then the complete corrected file and nothing else. Fix the actual cause of the error; do not remove functionality to make it pass.`,
	].join("\n");

// Generate an artifact and, if it is executable, run it in the sandbox
// and let the model fix-and-rerun autonomously up to BUILD_MAX times.
// Returns the final parsed file, the last execution result, and a build
// log. `scratchRunner` is injectable for tests (defaults to the real
// Part 10 sandbox).
async function runProto({ assumption, scratchRunner = null }) {
	const runOnce = scratchRunner || defaultScratchRun;

	const messages = [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "system", content: OUTPUT_FORMAT_INSTRUCTION },
		{ role: "user", content: assumption },
	];

	let tokensIn = 0;
	let tokensOut = 0;
	let costUsd = 0;
	let calls = 0;
	let cacheHits = 0;
	let wallClockS = 0;

	const gen = async (msgs) => {
		const t0 = Date.now();
		const { content, usage, costUsd: cc, cacheHit } = await callFlash(msgs, { model: MODEL, maxTokens: 4096 });
		wallClockS += (Date.now() - t0) / 1000;
		tokensIn += usage?.prompt_tokens ?? 0;
		tokensOut += usage?.completion_tokens ?? 0;
		costUsd += cc ?? 0;
		calls += 1;
		if (cacheHit) cacheHits += 1;
		return parseProtoResponse(content);
	};

	let parsed = (await gen(messages)) || (await gen(messages)); // one parse retry
	const cost = () => ({ tokensIn, tokensOut, costUsd, cacheHitRatio: calls ? cacheHits / calls : 0, wallClockS });

	if (!parsed) return { parsed: null, executionResult: null, buildIterations: 0, buildSucceeded: false, buildLog: [], ...cost() };

	const ext = path.extname(parsed.filename);
	if (!EXECUTORS[ext]) {
		// Non-executable artifact (landing page, one-pager) -- nothing to run.
		return { parsed, executionResult: null, buildIterations: 0, buildSucceeded: true, buildLog: [], ...cost() };
	}

	const buildLog = [];
	let executionResult = null;
	let lastStderr = null;

	for (let iter = 1; iter <= BUILD_MAX; iter++) {
		const command = EXECUTORS[ext](parsed.filename);
		executionResult = await runOnce({ filename: parsed.filename, content: parsed.content, command });
		buildLog.push({ iter, command, ok: executionResult.ok, exit: executionResult.exitCode ?? (executionResult.ok ? 0 : 1), stderr: (executionResult.stderr || "").slice(-1200) });

		if (executionResult.ok) return { parsed, executionResult, buildIterations: iter, buildSucceeded: true, buildLog, ...cost() };
		if (iter === BUILD_MAX) break;

		const stderr = [executionResult.stderr, executionResult.error, executionResult.timedOut ? "(the sandbox killed it — timed out)" : ""].filter(Boolean).join("\n").trim();
		if (stderr && stderr === lastStderr) {
			buildLog.push({ iter: iter + 0.5, note: "same error as the previous attempt — stopping (no progress)" });
			break;
		}
		lastStderr = stderr;

		const fixed = await gen([
			{ role: "system", content: OUTPUT_FORMAT_INSTRUCTION },
			{ role: "user", content: FIX_PROMPT(assumption, parsed.filename, parsed.content, command, executionResult.exitCode ?? 1, stderr) },
		]);
		if (!fixed) {
			buildLog.push({ iter: iter + 0.5, note: "fix attempt did not return a parseable file — stopping" });
			break;
		}
		parsed = fixed;
	}

	return { parsed, executionResult, buildIterations: buildLog.filter((e) => e.command).length, buildSucceeded: false, buildLog, ...cost() };
}

// The real sandbox run (Part 10). Isolated in its own scratch dir per
// attempt; the whole loop stays inside run.sh -- no new surface.
async function defaultScratchRun({ filename, content, command }) {
	const scratchDir = fs.mkdtempSync(path.join(os.homedir(), "scratch", "proto-"));
	try {
		fs.writeFileSync(path.join(scratchDir, filename), content, "utf8");
		return await runInSandbox({ scratchDir, command });
	} finally {
		fs.rmSync(scratchDir, { recursive: true, force: true });
	}
}

async function handleProtoCommand({ command, ack, client }) {
	const founder = founderForUserId(command.user_id);
	if (!founder) {
		await ack(); // D-40: off-allowlist -> silent
		return;
	}

	// 15.2: /proto needs a project.
	if (command.channel_id === channelId("chats")) {
		await ack();
		const dest = commandDestination(command);
		await postNeedsProject({
			client,
			channel: dest.channel,
			threadTs: dest.threadTs,
			what: "`/proto` builds an artifact and runs it in the sandbox.",
		});
		emit(buildEvalEvent({ stage: STAGE, founder, status: "refused", reasonCode: "needs_project" }));
		return;
	}

	// Project channel (16.3): id from the channel, the whole argument is
	// the assumption, output into the Prototype stage thread.
	const pdest = commandDestination(command);
	const text = (command.text || "").trim();
	let id;
	let assumption;
	if (pdest.project) {
		id = pdest.project.id;
		assumption = text;
	} else {
		const spaceIdx = text.indexOf(" ");
		id = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
		assumption = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
	}

	// Refuses if: no named assumption (D-29).
	if (!id || !assumption) {
		await ack({
			response_type: "ephemeral",
			text: pdest.project
				? "`/proto` refuses without a named assumption: `/proto <assumption>`"
				: "`/proto` refuses without a named assumption: `/proto <id> <assumption>`",
		});
		return;
	}

	if (!ideaExists(id)) {
		await ack({ response_type: "ephemeral", text: `\`/proto\` can't find idea \`${id}\`.` });
		return;
	}

	const state = readState(id);

	// Refuses if: state is killed.
	if (state?.state === "killed") {
		await ack({
			response_type: "ephemeral",
			text: `\`/proto\` refuses: \`${id}\` is killed. That verdict doesn't get worked around with a prototype.`,
		});
		return;
	}

	await ack();

	let millChannel = channelId("mill");
	let protoThreadTs;
	if (pdest.project) {
		await ensureStageThread(client, pdest);
		millChannel = pdest.channel; // post into the project channel...
		protoThreadTs = pdest.threadTs; // ...Prototype stage thread
	}
	if (!millChannel) {
		console.error("SLACK_CHANNEL_MILL not configured — /proto cannot post its result anywhere");
	}

	const touchCount = state?.touch_count ?? 0;

	// At touch 5: refuse further iterations. touchCount is the count of
	// completed touches, so this is the 6th attempt.
	if (touchCount >= TOUCH_CAP) {
		if (millChannel) {
			await postResult(client, {
				channel: millChannel, ...(protoThreadTs ? { thread_ts: protoThreadTs } : {}),
				text: "Touch cap reached. Either this assumption was answered three touches ago, or you've decided to build this — which is a different conversation with a different budget.",
			});
		}
		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder,
				ideaId: id,
				status: "refused",
				reasonCode: "touch_cap_reached",
			}),
		);
		return;
	}

	// Bug 1: model call + sandbox run is an invisible stretch. Update the
	// "On it…" placeholder in place if there is one, else drop a breadcrumb.
	const bread = `_Building the prototype for \`${id}\`…_`;
	if (command.progress && command.progress.channel === millChannel) {
		await client.chat.update({ channel: command.progress.channel, ts: command.progress.ts, text: bread }).catch(() => {});
	} else if (millChannel) {
		await client.chat.postMessage({ channel: millChannel, ...(protoThreadTs ? { thread_ts: protoThreadTs } : {}), text: bread }).catch(() => {});
	}

	try {
		const { parsed, executionResult, buildIterations, buildSucceeded, buildLog, tokensIn, tokensOut, costUsd, cacheHitRatio, wallClockS } = await runProto({ assumption });

		if (buildIterations > 1 && command.progress && command.progress.channel === millChannel) {
			await client.chat
				.update({ channel: command.progress.channel, ts: command.progress.ts, text: `_Prototype for \`${id}\`: ${buildSucceeded ? "built and running" : `built, ${buildIterations} sandbox attempts`}…_` })
				.catch(() => {});
		}

		if (!parsed) {
			emit(
				buildEvalEvent({
					stage: STAGE,
					model: MODEL,
					founder,
					ideaId: id,
					tokensIn,
					tokensOut,
					costUsd,
					cacheHitRatio,
					wallClockS,
					status: "failed",
					reasonCode: "unparseable_artifact",
				}),
			);
			if (millChannel) {
				await postResult(client, {
					channel: millChannel, ...(protoThreadTs ? { thread_ts: protoThreadTs } : {}),
					text: `\`/proto\` failed for \`${id}\`: the model didn't return a parseable artifact after one retry.`,
				});
			}
			return;
		}

		const touchN = touchCount + 1;
		const touchDir = path.join(IDEAS_DIR, id, "proto", String(touchN));
		fs.mkdirSync(touchDir, { recursive: true });
		// runProto has already built, run, and (for executables) fix-and-
		// re-run inside the Part 10 sandbox up to BUILD_MAX times. Persist
		// the final artifact + its last run output + the build log.
		fs.writeFileSync(path.join(touchDir, parsed.filename), parsed.content, "utf8");
		if (executionResult) {
			fs.writeFileSync(
				path.join(touchDir, "output.txt"),
				`command: ${EXECUTORS[path.extname(parsed.filename)]?.(parsed.filename) || "(none)"}\nexit ok: ${executionResult.ok}\n\nstdout:\n${executionResult.stdout}\n\nstderr:\n${executionResult.stderr}\n`,
				"utf8",
			);
		}
		if (buildLog.length) {
			fs.writeFileSync(
				path.join(touchDir, "build-log.md"),
				`# Build log — ${id} touch ${touchN}\n\n**Assumption:** ${assumption}\n\n` +
					buildLog
						.map((e) =>
							e.note
								? `- _${e.note}_`
								: `## Attempt ${e.iter}\n\`${e.command}\` → exit ${e.exit} (${e.ok ? "ok" : "error"})\n${e.ok ? "" : "```\n" + (e.stderr || "").trim() + "\n```"}`,
						)
						.join("\n\n") +
					`\n\n**Result:** ${buildSucceeded ? "runs clean" : `did not converge in ${BUILD_MAX} attempts`}\n`,
				"utf8",
			);
		}

		updateState(id, { state: "prototyping", touch_count: touchN });

		await commitAndPush(
			[`ideas/${id}`],
			`idea ${id}: proto touch ${touchN} (${parsed.filename}) by ${founder}`,
			(reason) => console.error(`git commit/push failed for idea ${id} proto: ${reason}`),
		);

		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder,
				ideaId: id,
				tokensIn,
				tokensOut,
				costUsd,
				cacheHitRatio,
				wallClockS,
				status: "ok",
				reasonCode: executionResult ? (buildSucceeded ? `build_ok_${buildIterations}` : `build_failed_${buildIterations}`) : null,
				buildIterations,
				buildSucceeded: executionResult ? buildSucceeded : null,
			}),
		);

		const lines = [
			`Touch ${touchN}/${TOUCH_CAP} for \`${id}\`: wrote \`${parsed.filename}\`.`,
		];
		if (executionResult) {
			const attemptNote = buildIterations > 1 ? ` (${buildIterations} sandbox attempts)` : "";
			lines.push(
				executionResult.ok
					? `Ran in sandbox${attemptNote}:\n\`\`\`\n${executionResult.stdout.slice(0, 1500)}\n\`\`\``
					: `Ran in sandbox${attemptNote}, still exits with an error — see \`proto/${touchN}/build-log.md\`:\n\`\`\`\n${executionResult.stderr.slice(0, 1500)}\n\`\`\``,
			);
		}
		if (touchN === TOUCH_CAP) {
			lines.push("_This was the fifth touch — the next /proto on this idea will be refused._");
		}
		if (millChannel) {
			const body = lines.join("\n\n");
			const msg = { channel: millChannel, ...(protoThreadTs ? { thread_ts: protoThreadTs } : {}), text: body };
			// 18.4: /proto builds only. In a project, offer a Mount button
			// for this touch (takes the single ngrok slot).
			if (pdest.project) {
				msg.blocks = [
					{ type: "section", text: { type: "mrkdwn", text: body.slice(0, 2900) } },
					{ type: "actions", elements: [{ type: "button", action_id: "proto_mount", text: { type: "plain_text", text: `Mount touch ${touchN}` }, value: `${id}::${touchN}::${MOUNT_DEFAULT_MIN}` }] },
				];
			}
			const protoPost = await postResult(client, msg);
			// D-52: state is now `prototyping` at touch N -- refresh the card.
			if (pdest.project) await upsertStateCard(client, id, { latestTs: protoPost?.ts, latestChannel: millChannel });
		}
	} catch (err) {
		console.error("proto command failed:", err);
		emit(
			buildEvalEvent({
				stage: STAGE,
				founder,
				ideaId: id,
				status: "failed",
				reasonCode: "proto_call_failed",
			}),
		);
		if (millChannel) {
			await client.chat
				.postMessage({
					channel: millChannel, ...(protoThreadTs ? { thread_ts: protoThreadTs } : {}),
					text: `\`/proto\` failed for \`${id}\`: ${err?.message || err}`,
				})
				.catch(() => {});
		}
	}
}

module.exports = { handleProtoCommand, runProto, parseProtoResponse };
