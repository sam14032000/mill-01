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
	// state.consumed flips true once the placeholder has actually been
	// written to. agent.js reads it after a tool call: a "posted" tool
	// whose handler silently failed to land its output (e.g. Slack
	// msg_too_long, swallowed by the handler's own catch) would otherwise
	// leave the "Thinking…" placeholder hung forever (seen live
	// 2026-08-30).
	const state = { consumed: false };
	const origUpdate = client.chat.update.bind(client.chat);

	chat.postResult = async (msg = {}) => {
		// Only redirect a post that targets the same channel as the
		// placeholder (a kill's #graveyard post, an audit fallback to
		// #research, etc. stay separate messages).
		if (!state.consumed && msg.channel === progressChannel) {
			const r = await origUpdate({ channel: progressChannel, ts: progressTs, text: msg.text, blocks: msg.blocks });
			state.consumed = true; // only on success -- a throw leaves it false
			return r;
		}
		return client.chat.postMessage(msg);
	};

	// Multi-message commands (/test, /proto) update the placeholder
	// directly for interim stage lines -- count those too.
	chat.update = async (msg = {}) => {
		const r = await origUpdate(msg);
		if (msg && msg.ts === progressTs && (msg.channel === progressChannel || !msg.channel)) state.consumed = true;
		return r;
	};

	chat.progress = { ts: progressTs, channel: progressChannel };
	chat.progressState = state;
	const wrapped = Object.create(client);
	wrapped.chat = chat;
	return wrapped;
}

module.exports = { postResult, withProgress };
