"use strict";

// Lets a command post a question in a thread and wait for a specific
// founder's reply in that same thread, with a timeout -- /test's field-
// evidence prompt (docs/COMMANDS.md: "Waits up to 30 minutes"). Bolt
// registers message handlers once at startup, not per-invocation, so
// this is a small in-memory registry keyed by thread_ts that the main
// message handler checks before falling through to anything else
// (capture-writing, etc).

const pending = new Map(); // thread_ts -> { founderUserId, resolve }

function waitForThreadReply(threadTs, founderUserId, timeoutMs) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			pending.delete(threadTs);
			resolve({ replied: false, text: null });
		}, timeoutMs);

		pending.set(threadTs, {
			founderUserId,
			resolve: (text) => {
				clearTimeout(timer);
				pending.delete(threadTs);
				resolve({ replied: true, text });
			},
		});
	});
}

// Called from index.js's generic message handler. Returns true if this
// message was consumed as a pending thread reply -- caller should treat
// it as handled and not process it as anything else (e.g. a capture).
function handleThreadMessage(message) {
	const threadTs = message.thread_ts;
	if (!threadTs) return false;
	const entry = pending.get(threadTs);
	if (!entry) return false;
	if (entry.founderUserId !== message.user) return false; // only the asking founder's reply counts
	entry.resolve((message.text || "").trim());
	return true;
}

module.exports = { waitForThreadReply, handleThreadMessage };
