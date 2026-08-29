"use strict";

// Bug 1 (live use): a command invoked from a thread posted an immediate
// "On it — running /attack…" placeholder, then the handler posted its
// result as a *separate* message and the placeholder just sat there
// marked "(edited)". The handler must land its terminal message in the
// placeholder's ts.
//
// `withProgress(client, {progressTs, progressChannel})` returns a client
// whose `chat.postResult` redirects its FIRST call into that placeholder
// (`chat.update`); everything else passes through. `postResult(client,
// msg)` is what handlers call for their one terminal result — it falls
// back to `chat.postMessage` when there's no placeholder (a raw slash
// command from the channel body) or on a bare mock client in tests.

function postResult(client, msg) {
	const chat = client && client.chat;
	const fn = (chat && chat.postResult) || (chat && chat.postMessage);
	return fn.call(chat, msg);
}

function withProgress(client, { progressTs = null, progressChannel = null } = {}) {
	if (!progressTs) return client;
	const chat = Object.create(client.chat);
	let used = false;
	chat.postResult = async (msg = {}) => {
		// Only redirect a post that targets the same channel as the
		// placeholder (a kill's #graveyard post, an audit fallback to
		// #research, etc. stay separate messages).
		if (!used && msg.channel === progressChannel) {
			used = true;
			return client.chat.update({
				channel: progressChannel,
				ts: progressTs,
				text: msg.text,
				blocks: msg.blocks,
			});
		}
		return client.chat.postMessage(msg);
	};
	// Also expose the placeholder so multi-message commands (/test, /proto)
	// can update it for interim stage lines.
	chat.progress = { ts: progressTs, channel: progressChannel };
	const wrapped = Object.create(client);
	wrapped.chat = chat;
	return wrapped;
}

module.exports = { postResult, withProgress };
