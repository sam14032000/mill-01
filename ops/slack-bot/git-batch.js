"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BATCH_INTERVAL_MS = 15 * 60 * 1000;

function run(cmd, args) {
	return new Promise((resolve) => {
		execFile(cmd, args, { cwd: REPO_ROOT }, (error, stdout, stderr) => {
			resolve({ error, stdout, stderr });
		});
	});
}

// Batches captures every 15 minutes rather than committing per message —
// per docs/COMMANDS.md capture spec. A git push failure logs and keeps
// working; it never blocks a command (COMMANDS.md failure-handling table).
async function commitCaptures(onFailure) {
	const status = await run("git", ["status", "--porcelain", "--", "minds"]);
	if (status.error) {
		onFailure?.(`git status failed: ${status.error.message}`);
		return;
	}
	if (!status.stdout.trim()) return; // nothing to commit

	const add = await run("git", ["add", "minds"]);
	if (add.error) {
		onFailure?.(`git add failed: ${add.error.message}`);
		return;
	}

	const commit = await run("git", [
		"commit",
		"-m",
		"captures: batch commit",
	]);
	if (commit.error) {
		onFailure?.(`git commit failed: ${commit.error.message}`);
		return;
	}

	const push = await run("git", ["push", "origin", "main"]);
	if (push.error) {
		onFailure?.(`git push failed: ${push.error.message}`);
	}
}

function startBatchCommitLoop(onFailure) {
	return setInterval(() => {
		commitCaptures(onFailure).catch((err) => onFailure?.(String(err)));
	}, BATCH_INTERVAL_MS);
}

module.exports = { commitCaptures, startBatchCommitLoop, BATCH_INTERVAL_MS };
