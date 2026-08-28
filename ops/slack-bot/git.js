"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");
const { postToMill } = require("./notify");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Test/verification ideas use the `zz` prefix (ideas/zz16, ideas/zzI2, ...).
// commitAndPush scopes to explicit paths, but those paths include `ideas/`,
// so a verification run that exercises the real /attack, /proto, promote or
// dismount path would commit its throwaway idea and need a cleanup commit
// afterward (this happened four times across Parts 14-17 + I2). This magic
// pathspec is appended to every git operation so the bot never stages,
// never commits, and never reports on anything under ideas/zz*. Real idea
// ids are 4-char lowercase hex and can start "zz" only 1/65536 of the time
// -- generateIdeaId() rejects any id matching /^zz/ to keep the namespaces
// disjoint.
// No `glob` magic: default pathspec wildmatch lets `*` cross `/`, so
// `ideas/zz*` also excludes `ideas/zzNEW/state.json` etc. (with `glob` it
// would only match the directory name, not its children).
const EXCLUDE_TEST_IDEAS = ":(exclude)ideas/zz*";

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
	const scoped = [...paths, EXCLUDE_TEST_IDEAS];
	const status = await run("git", ["status", "--porcelain", "--", ...scoped]);
	if (status.error) {
		await reportGitFailure(onFailure, `status failed: ${status.error.message}`);
		return false;
	}
	if (!status.stdout.trim()) return false;

	// Stage and commit ONLY these paths, explicitly. `git add <paths>`
	// scopes what gets staged; `git commit -- <paths>` scopes what gets
	// committed even if something else is already in the index. Without
	// the pathspec on `commit`, a bare `git commit -m` records the entire
	// staged index -- so anything a founder happens to have `git add`ed
	// while working in the same clone (constant during the projects
	// phase) gets committed by the bot under a "captures: batch commit"
	// message. Both halves are needed: `add` picks up new untracked
	// files under the paths (e.g. a fresh ideas/<id>/), `commit -- paths`
	// fences everything else out.
	const add = await run("git", ["add", "--", ...scoped]);
	if (add.error) {
		await reportGitFailure(onFailure, `add failed: ${add.error.message}`);
		return false;
	}

	const commit = await run("git", ["commit", "-m", message, "--", ...scoped]);
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
	// --autostash: a founder working in the same clone will usually have
	// unstaged edits in flight, and `git rebase` refuses to run against a
	// dirty tree. Autostash pockets those edits, rebases our commit onto
	// origin/main, and re-applies them. A pop conflict (different paths,
	// so very unlikely) leaves the edits safely in the stash and surfaces
	// below rather than being lost.
	const rebase = await run("git", ["rebase", "--autostash", "origin/main"]);
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
