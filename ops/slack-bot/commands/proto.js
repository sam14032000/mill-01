"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { founderForUserId, channelId } = require("../config");
const { callFlash } = require("../llm");
const { ideaExists, readState, updateState, IDEAS_DIR } = require("../ideas");
const { runInSandbox } = require("../sandbox");
const tree = require("../proto-tree");
const { readDoc } = require("../mode-docs");
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
	"Build the smallest artifact that tests this one assumption. Default to non-code — landing page, mock flow, fake pricing table, one-pager.",
	"Only write executable code if the assumption is technical.",
	"This will be deleted. Do not build for durability.",
	"A prototype may be several files (a page plus its stylesheet, a few screens in a flow). Keep it as small as the assumption allows — more files is not better.",
].join("\n");

// docs/COMMANDS.md doesn't specify an output format for the artifact
// itself (unlike /attack's ASSUMPTION:/TOO_VAGUE: markers) -- this
// instruction exists only so the response can be parsed and saved to a
// real filename; it doesn't change what the model is asked to build.
const OUTPUT_FORMAT_INSTRUCTION = [
	"Output format: for each file, a line that is exactly `===FILE: <relative/path.ext>===` followed by that file's COMPLETE content.",
	"Repeat for each file. To remove a file, use a line `===DELETE: <relative/path.ext>===` on its own.",
	"Paths are relative and must stay inside the project — no leading `/`, no `..`.",
	"Choose extensions yourself: .html/.css/.md for non-code, .py/.js/.sh only if the assumption is technical.",
	"No explanation before or after the file blocks.",
].join("\n");

// THE RECONCILE INSTRUCTION — the reason a touch is now an edit.
//
// Framed as a per-file decision rather than "build the project", for the
// reason D-57 records: handing a model a blank page is what makes it
// silently drop things nobody asked it to remove. Proven there on
// documents; the same failure was live here, where every touch
// regenerated from the assumption alone.
const EDIT_INSTRUCTION = [
	"You are EDITING an existing prototype, not building a new one.",
	"Go file by file and decide:",
	"  • UNCHANGED — the request doesn't touch it. Do NOT emit it at all.",
	"  • EDIT — emit `===FILE: <path>===` with its complete new content.",
	"  • ADD — emit `===FILE: <path>===` for a genuinely new file.",
	"  • DELETE — emit `===DELETE: <path>===`.",
	"Emit ONLY the files you are changing. A file you do not emit is left exactly as it is,",
	"which is what you want for everything the founder didn't ask about — re-emitting an",
	"unchanged file risks losing detail from it for no gain.",
].join("\n");

// Extensions that get executed in the Part 10 sandbox after being
// written -- anything else is an artifact only (landing page, pricing
// table, etc), per "Only write executable code if the assumption is
// technical."
const EXECUTORS = {
	".py": (filename) => `python3 /scratch/${filename}`,
	".js": (filename) => `node /scratch/${filename}`,
	".sh": (filename) => `bash /scratch/${filename}`,
};



// The project itself is supplied separately (renderTree), so this stays
// about the failure rather than restating files the model already has.
const FIX_PROMPT = (assumption, entry, command, exitCode, stderr) =>
	[
		`This prototype was built to test the assumption: ${assumption}`,
		`Its entry point \`${entry}\` was run in a locked-down sandbox as: ${command}`,
		`It exited with code ${exitCode}. stderr:`,
		"```",
		stderr.slice(-2000),
		"```",
		"",
		"Emit only the files you need to change to fix this. Fix the actual cause of the error; do not remove functionality to make it pass.",
	].join("\n");

// Which file the sandbox runs. Convention first (an explicit entry point
// beats guessing), then any executable file, then nothing — a landing
// page or a one-pager has no entry point and is not supposed to run.
const ENTRY_PREFERENCE = ["main.py", "app.py", "main.js", "app.js", "index.js", "run.sh", "main.sh"];
function pickEntryPoint(files) {
	const names = Object.keys(files);
	for (const pref of ENTRY_PREFERENCE) if (names.includes(pref)) return pref;
	const executables = names.filter((n) => EXECUTORS[path.extname(n)]).sort();
	return executables[0] || null;
}

// Generate an artifact and, if it is executable, run it in the sandbox
// and let the model fix-and-rerun autonomously up to BUILD_MAX times.
// Returns the final parsed file, the last execution result, and a build
// log. `scratchRunner` is injectable for tests (defaults to the real
// Part 10 sandbox).
// `ideaId` and `touchDir` are what turn this from a blind regeneration
// into an edit: the model is shown the CURRENT tree and the specs the
// prototype is supposed to embody, not just a one-line assumption.
async function runProto({ assumption, request = "", ideaId = null, priorDir = null, scratchRunner = null }) {
	const runOnce = scratchRunner || defaultScratchRun;

	const priorTree = priorDir ? tree.readTree(priorDir) : {};
	const isEdit = Object.keys(priorTree).length > 0;

	// Proto's input document is the engineering spec (D-54's feeding
	// rule); the product spec comes with it because a builder that cannot
	// see what the thing is for builds the wrong thing.
	const specs = [];
	if (ideaId) {
		const product = readDoc(ideaId, "product");
		const engineering = readDoc(ideaId, "engineering");
		if (product) specs.push(`--- PRODUCT SPEC ---\n${product}`);
		if (engineering) specs.push(`--- ENGINEERING SPEC ---\n${engineering}`);
	}

	const messages = [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "system", content: OUTPUT_FORMAT_INSTRUCTION },
		...(isEdit ? [{ role: "system", content: EDIT_INSTRUCTION }] : []),
		// Stable context first, volatile last — prefix caching (COMMANDS.md).
		...(specs.length ? [{ role: "system", content: specs.join("\n\n") }] : []),
		...(isEdit ? [{ role: "system", content: tree.renderTree(priorTree) }] : []),
		{
			role: "user",
			content: isEdit
				? `The assumption under test: ${assumption}\n\nWhat to change: ${request || assumption}`
				: assumption,
		},
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
		return tree.parseTreeResponse(content);
	};

	let parsed = (await gen(messages)) || (await gen(messages)); // one parse retry
	const cost = () => ({ tokensIn, tokensOut, costUsd, cacheHitRatio: calls ? cacheHits / calls : 0, wallClockS });

	if (!parsed) return { parsed: null, executionResult: null, buildIterations: 0, buildSucceeded: false, buildLog: [], ...cost() };

	// The tree as it WILL be: what came back, layered over what was there.
	// A file the model didn't emit is unchanged, so it has to be carried
	// forward here or the run would execute a half-project.
	const merged = { ...priorTree, ...parsed.files };
	for (const rel of parsed.deletes || []) delete merged[rel];

	const entry = pickEntryPoint(merged);
	if (!entry) {
		// Non-executable artifact (landing page, one-pager) -- nothing to run.
		return { parsed, executionResult: null, buildIterations: 0, buildSucceeded: true, buildLog: [], ...cost() };
	}
	const ext = path.extname(entry);

	const buildLog = [];
	let executionResult = null;
	let lastStderr = null;

	for (let iter = 1; iter <= BUILD_MAX; iter++) {
		const command = EXECUTORS[ext](entry);
		executionResult = await runOnce({ files: { ...priorTree, ...parsed.files }, command });
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
			{ role: "system", content: EDIT_INSTRUCTION },
			{ role: "system", content: tree.renderTree({ ...priorTree, ...parsed.files }) },
			{ role: "user", content: FIX_PROMPT(assumption, entry, command, executionResult.exitCode ?? 1, stderr) },
		]);
		if (!fixed) {
			buildLog.push({ iter: iter + 0.5, note: "fix attempt did not return a parseable file — stopping" });
			break;
		}
		// A fix is itself an edit: layer it over what we already have
		// rather than replacing the project with whatever the fix emitted.
		parsed = { files: { ...parsed.files, ...fixed.files }, deletes: [...(parsed.deletes || []), ...(fixed.deletes || [])] };
	}

	return { parsed, executionResult, buildIterations: buildLog.filter((e) => e.command).length, buildSucceeded: false, buildLog, ...cost() };
}

// The real sandbox run (Part 10). Isolated in its own scratch dir per
// attempt; the whole loop stays inside run.sh -- no new surface.
async function defaultScratchRun({ files, command }) {
	const scratchDir = fs.mkdtempSync(path.join(os.homedir(), "scratch", "proto-"));
	try {
		// The whole project goes in, not just the entry point — a
		// multi-file prototype that imports a sibling would otherwise fail
		// in the sandbox for a reason that has nothing to do with the code.
		// Reuses the same path guard as everything else.
		for (const [rel, content] of Object.entries(files || {})) {
			const full = tree.safeJoin(scratchDir, rel);
			if (!full) continue;
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, content, "utf8");
		}
		return await runInSandbox({ scratchDir, command });
	} finally {
		fs.rmSync(scratchDir, { recursive: true, force: true });
	}
}

// What actually changed, in a line a founder can read. "wrote app.js"
// was fine when a prototype was one file; with a tree the useful facts
// are what moved and what didn't.
function describeChange(applied) {
	const added = applied.written.filter((w) => w.added).map((w) => w.path);
	const edited = applied.written.filter((w) => !w.added).map((w) => w.path);
	const bits = [];
	if (added.length) bits.push(`added ${added.map((p) => `\`${p}\``).join(", ")}`);
	if (edited.length) bits.push(`changed ${edited.map((p) => `\`${p}\``).join(", ")}`);
	if (applied.removed.length) bits.push(`removed ${applied.removed.map((p) => `\`${p}\``).join(", ")}`);
	if (!bits.length) bits.push("no files changed");
	const kept = applied.unchanged.length;
	return `${bits.join("; ")}${kept ? ` (${kept} other file${kept === 1 ? "" : "s"} untouched)` : ""}`;
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
		// The touch we are editing forward FROM. Without this the model
		// never sees what it built last time, which is the whole bug.
		const priorDir = touchCount > 0 ? path.join(IDEAS_DIR, id, "proto", String(touchCount)) : null;
		const { parsed, executionResult, buildIterations, buildSucceeded, buildLog, tokensIn, tokensOut, costUsd, cacheHitRatio, wallClockS } = await runProto({
			assumption, request: assumption, ideaId: id, priorDir,
		});

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
		// Carry the previous touch forward FIRST, then apply only what the
		// model emitted. This is what makes a touch an edit: everything the
		// founder didn't ask about is already there, byte-identical, before
		// a single change lands.
		if (priorDir) tree.copyTreeForward(priorDir, touchDir);
		const applied = tree.applyTree(touchDir, parsed);
		// runProto has already built, run, and (for executables) fix-and-
		// re-run inside the Part 10 sandbox up to BUILD_MAX times. Persist
		// the final artifact + its last run output + the build log.
		if (executionResult) {
			fs.writeFileSync(
				path.join(touchDir, "output.txt"),
				`command: ${executionResult.command || "(none)"}\nexit ok: ${executionResult.ok}\n\nstdout:\n${executionResult.stdout}\n\nstderr:\n${executionResult.stderr}\n`,
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
			`idea ${id}: proto touch ${touchN} (${applied.fileCount} files) by ${founder}`,
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
			`Touch ${touchN}/${TOUCH_CAP} for \`${id}\`: ${describeChange(applied)}.`,
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

module.exports = { handleProtoCommand, runProto, pickEntryPoint, describeChange };
