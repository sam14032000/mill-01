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
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");

const MODEL = "flash-fast";
const STAGE = "proto";
const TOUCH_CAP = 5;

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

async function runProto({ assumption }) {
	const messages = [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "system", content: OUTPUT_FORMAT_INSTRUCTION },
		{ role: "user", content: assumption },
	];

	let parsed = null;
	let tokensIn = 0;
	let tokensOut = 0;
	let costUsd = 0;
	let calls = 0;
	let cacheHits = 0;
	let wallClockS = 0;

	for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
		const t0 = Date.now();
		const { content, usage, costUsd: callCost, cacheHit } = await callFlash(messages, { model: MODEL, maxTokens: 4096 });
		wallClockS += (Date.now() - t0) / 1000;
		tokensIn += usage?.prompt_tokens ?? 0;
		tokensOut += usage?.completion_tokens ?? 0;
		costUsd += callCost ?? 0;
		calls += 1;
		if (cacheHit) cacheHits += 1;
		parsed = parseProtoResponse(content);
	}

	return { parsed, tokensIn, tokensOut, costUsd, cacheHitRatio: calls ? cacheHits / calls : 0, wallClockS };
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
			await client.chat.postMessage({
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

	try {
		const { parsed, tokensIn, tokensOut, costUsd, cacheHitRatio, wallClockS } = await runProto({ assumption });

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
				await client.chat.postMessage({
					channel: millChannel, ...(protoThreadTs ? { thread_ts: protoThreadTs } : {}),
					text: `\`/proto\` failed for \`${id}\`: the model didn't return a parseable artifact after one retry.`,
				});
			}
			return;
		}

		const touchN = touchCount + 1;
		const touchDir = path.join(IDEAS_DIR, id, "proto", String(touchN));
		fs.mkdirSync(touchDir, { recursive: true });
		fs.writeFileSync(path.join(touchDir, parsed.filename), parsed.content, "utf8");

		const ext = path.extname(parsed.filename);
		let executionResult = null;

		// Executable output: runs in the Part 10 sandbox. Nothing else
		// executes -- sandbox.js's runInSandbox is the only function in
		// this codebase that runs generated content, and it always goes
		// through Part 10's run.sh.
		if (EXECUTORS[ext]) {
			const scratchDir = fs.mkdtempSync(path.join(os.homedir(), "scratch", "proto-"));
			try {
				fs.writeFileSync(path.join(scratchDir, parsed.filename), parsed.content, "utf8");
				executionResult = await runInSandbox({
					scratchDir,
					command: EXECUTORS[ext](parsed.filename),
				});
				fs.writeFileSync(
					path.join(touchDir, "output.txt"),
					`stdout:\n${executionResult.stdout}\n\nstderr:\n${executionResult.stderr}\n`,
					"utf8",
				);
			} finally {
				fs.rmSync(scratchDir, { recursive: true, force: true });
			}
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
			}),
		);

		const lines = [
			`Touch ${touchN}/${TOUCH_CAP} for \`${id}\`: wrote \`${parsed.filename}\`.`,
		];
		if (executionResult) {
			lines.push(
				executionResult.ok
					? `Ran in sandbox:\n\`\`\`\n${executionResult.stdout.slice(0, 1500)}\n\`\`\``
					: `Ran in sandbox, exited with an error:\n\`\`\`\n${executionResult.stderr.slice(0, 1500)}\n\`\`\``,
			);
		}
		if (touchN === TOUCH_CAP) {
			lines.push("_This was the fifth touch — the next /proto on this idea will be refused._");
		}
		if (millChannel) {
			await client.chat.postMessage({ channel: millChannel, ...(protoThreadTs ? { thread_ts: protoThreadTs } : {}), text: lines.join("\n\n") });
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
