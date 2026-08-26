"use strict";

const { commitAndPush } = require("./git");

const BATCH_INTERVAL_MS = 15 * 60 * 1000;

// Batches captures every 15 minutes rather than committing per message —
// per docs/COMMANDS.md's capture spec. Ideas, by contrast, commit
// immediately on creation (see commands/attack.js) since each is a
// discrete, low-frequency event rather than a stream of small appends.
async function commitCaptures(onFailure) {
	await commitAndPush(["minds"], "captures: batch commit", onFailure);
}

function startBatchCommitLoop(onFailure) {
	return setInterval(() => {
		commitCaptures(onFailure).catch((err) => onFailure?.(String(err)));
	}, BATCH_INTERVAL_MS);
}

module.exports = { commitCaptures, startBatchCommitLoop, BATCH_INTERVAL_MS };
