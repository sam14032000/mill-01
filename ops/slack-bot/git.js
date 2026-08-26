"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function run(cmd, args) {
	return new Promise((resolve) => {
		execFile(cmd, args, { cwd: REPO_ROOT }, (error, stdout, stderr) => {
			resolve({ error, stdout, stderr });
		});
	});
}

// Commits and pushes only the given paths (relative to repo root), if
// there's actually something to commit under them. Never throws -- per
// docs/COMMANDS.md's failure-handling table, a git push failure logs and
// alerts, but must never block the command that triggered it. Returns
// true if a commit was made, false otherwise (nothing to commit, or a
// step failed after being reported via onFailure).
async function commitAndPush(paths, message, onFailure) {
	const status = await run("git", ["status", "--porcelain", "--", ...paths]);
	if (status.error) {
		onFailure?.(`git status failed: ${status.error.message}`);
		return false;
	}
	if (!status.stdout.trim()) return false;

	const add = await run("git", ["add", ...paths]);
	if (add.error) {
		onFailure?.(`git add failed: ${add.error.message}`);
		return false;
	}

	const commit = await run("git", ["commit", "-m", message]);
	if (commit.error) {
		onFailure?.(`git commit failed: ${commit.error.message}`);
		return false;
	}

	const push = await run("git", ["push", "origin", "main"]);
	if (push.error) {
		onFailure?.(`git push failed: ${push.error.message}`);
		return false;
	}
	return true;
}

module.exports = { commitAndPush, run, REPO_ROOT };
