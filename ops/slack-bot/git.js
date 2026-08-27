"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");
const { postToMill } = require("./notify");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function run(cmd, args) {
	return new Promise((resolve) => {
		execFile(cmd, args, { cwd: REPO_ROOT }, (error, stdout, stderr) => {
			resolve({ error, stdout, stderr });
		});
	});
}

// Surfaces a git failure to #mill-ideas as well as the caller's onFailure
// callback. docs/COMMANDS.md's failure table: "Git push fails -> log
// locally, alert to #mill-ideas, keep working. Never block a command on
// git." Before this, onFailure was console.error at every call site, so a
// push that started failing (e.g. the remote moved) was invisible until
// someone noticed captures/ideas weren't landing in the shared repo.
async function reportGitFailure(onFailure, msg) {
	onFailure?.(msg);
	await postToMill(`git: ${msg}`).catch(() => {});
}

// Commits and pushes only the given paths (relative to repo root), if
// there's actually something to commit under them. Never throws. Returns
// true only if the commit was made AND pushed; false if there was nothing
// to commit, or a step failed (already reported).
async function commitAndPush(paths, message, onFailure) {
	const status = await run("git", ["status", "--porcelain", "--", ...paths]);
	if (status.error) {
		await reportGitFailure(onFailure, `status failed: ${status.error.message}`);
		return false;
	}
	if (!status.stdout.trim()) return false;

	const add = await run("git", ["add", ...paths]);
	if (add.error) {
		await reportGitFailure(onFailure, `add failed: ${add.error.message}`);
		return false;
	}

	const commit = await run("git", ["commit", "-m", message]);
	if (commit.error) {
		await reportGitFailure(onFailure, `commit failed: ${commit.error.message}`);
		return false;
	}

	// Both a founder and this bot push to origin/main during normal use
	// (and heavily during the projects phase), so the remote will have
	// moved out from under us routinely. Rebase our fresh commit on top
	// of whatever landed rather than failing the push. Capture files and
	// ideas/ dirs are append-mostly and per-founder, so a content
	// conflict is very unlikely -- but if one happens, abort cleanly and
	// leave the commit local for the next batch to retry, never leave a
	// half-finished rebase in the working tree.
	const fetch = await run("git", ["fetch", "origin", "main"]);
	if (fetch.error) {
		await reportGitFailure(onFailure, `fetch failed, commit is local only: ${fetch.error.message}`);
		return false;
	}
	const rebase = await run("git", ["rebase", "origin/main"]);
	if (rebase.error) {
		await run("git", ["rebase", "--abort"]);
		await reportGitFailure(
			onFailure,
			`rebase onto origin/main failed (conflict?), commit is local only and will retry next batch: ${(rebase.stderr || rebase.error.message).slice(0, 300)}`,
		);
		return false;
	}

	const push = await run("git", ["push", "origin", "main"]);
	if (push.error) {
		await reportGitFailure(
			onFailure,
			`push failed, commit is local only: ${(push.stderr || push.error.message).slice(0, 300)}`,
		);
		return false;
	}
	return true;
}

module.exports = { commitAndPush, run, REPO_ROOT };
