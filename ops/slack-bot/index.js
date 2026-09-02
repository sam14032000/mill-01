"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { App } = require("@slack/bolt");
const https = require("node:https");

const config = require("./config");
const { founderForUserId } = config;
const { writeCapture, MINDS_DIR } = require("./capture");
const { startBatchCommitLoop, commitCaptures } = require("./git-batch");
const { handleAttackCommand } = require("./commands/attack");
const { handleThinkCommand } = require("./commands/think");
const { handleCrossCommand } = require("./commands/cross");
const { handleBlindspotCommand } = require("./commands/blindspot");
const { handleThemesCommand } = require("./commands/themes");
const { handleSpinoffCommand } = require("./commands/spinoff");
const { handleTestCommand } = require("./commands/test");
const { handleAuditCommand } = require("./commands/audit");
const { handleProtoCommand } = require("./commands/proto");
const { handleChatCommand } = require("./commands/chat");
const { handleFindCommand } = require("./commands/find");
const { handleThreadMessage } = require("./thread-wait");
const { handleChatTurn } = require("./chat-turn");
const chatSession = require("./chat-session");
const { PROMOTE_ACTION_ID } = require("./promote-button");
const { parseMention } = require("./intent");
const { dispatchCommand } = require("./command-shim");
const { promoteChat } = require("./promotion");
const { handleProjectUpload } = require("./documents");
const mountMod = require("./mount");
const { readState, findIdeaByChannel } = require("./ideas");
const { switchMode } = require("./mode-switch");
const { startStalenessSweep, killStale } = require("./staleness");
const { runWeeklyProfileEvolution, handleDiffDecision } = require("./profile-evolution");
const { startWeeklyScheduler } = require("./weekly-scheduler");
const { startNightlyScheduler } = require("./nightly-capture");
const { startSocketHealth } = require("./socket-health");
const { wrapClientFormatting } = require("./mrkdwn");
const buttonResolve = require("./button-resolve");

const REQUIRED_ENV = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
for (const key of REQUIRED_ENV) {
	if (!process.env[key]) {
		console.error(`missing required env var: ${key}`);
		process.exit(1);
	}
}

const app = new App({
	token: process.env.SLACK_BOT_TOKEN,
	appToken: process.env.SLACK_APP_TOKEN,
	socketMode: true,
	// Bounded, deliberately. @slack/web-api defaults to NO request timeout
	// and `tenRetriesInAboutThirtyMinutes` — so a single stalled call can
	// hold a turn open for half an hour with nothing logged. That is how a
	// founder's message sat on "_Thinking…_" with the process idle: the
	// reply had already been generated and the chat.update that would have
	// shown it never came back. Same unbounded-network-wait class as the
	// llm.js body-read stall (D-08 amendment), one layer out.
	clientOptions: {
		timeout: 15_000,
		retryConfig: { retries: 3, factor: 2, minTimeout: 500, maxTimeout: 4_000 },
	},
});

// The models emit standard Markdown; Slack doesn't parse it. Convert
// every outbound chat.postMessage / chat.update at one choke point (see
// mrkdwn.js). app.client covers listeners that reuse it; the middleware
// below covers any per-request client Bolt hands a listener.
wrapClientFormatting(app.client);
app.use(async ({ client, next }) => {
	wrapClientFormatting(client);
	await next();
});

// Inbound-event log, kept permanently. Before this line there was zero
// logging of what Slack delivered, which is why the 2026-08-27 wedge
// (socket alive, events silently dropped) could not be diagnosed without
// live instrumentation. One line per dispatched request; no message
// content, only shape (type, channel kind, user, text length).
app.use(async ({ body, next }) => {
	try {
		const t = body?.type || body?.event?.type || "?";
		const ev = body?.event || {};
		console.log(
			`[inbound] type=${t} event_type=${ev.type || "-"} subtype=${ev.subtype || "-"} channel_type=${ev.channel_type || "-"} channel=${ev.channel || body?.channel_id || "-"} user=${ev.user || body?.user_id || "-"} command=${body?.command || "-"} text_len=${(ev.text || body?.text || "").length}`,
		);
	} catch (err) {
		console.log(`[inbound] (failed to introspect): ${err.message}`);
	}
	await next();
});

// All eight slash commands defined in Slack app config (Part 9.1) are
// now implemented, in the build order docs/COMMANDS.md/D-41 specify.
const STUBBED_COMMANDS = [];

app.command("/attack", handleAttackCommand);
app.command("/think", handleThinkCommand);
app.command("/cross", handleCrossCommand);
app.command("/test", handleTestCommand);
app.command("/audit", handleAuditCommand);
app.command("/proto", handleProtoCommand);
app.command("/blindspot", handleBlindspotCommand);
app.command("/themes", handleThemesCommand);
app.command("/spinoff", handleSpinoffCommand);
app.command("/chat", handleChatCommand);
app.command("/find", handleFindCommand);

for (const command of STUBBED_COMMANDS) {
	app.command(command, async ({ ack, command: cmd }) => {
		const founder = founderForUserId(cmd.user_id);
		if (!founder) {
			// D-40: off-allowlist -> silent. An empty ack produces no
			// visible bot reply; this is as close to "no reply" as
			// Slack's slash-command contract allows (it still requires
			// an ack within 3s or Slack itself shows a timeout error).
			await ack();
			return;
		}
		await ack({
			response_type: "ephemeral",
			text: `\`${command}\` isn't implemented yet — command logic lands in Part 9b (see docs/COMMANDS.md).`,
		});
	});
}

function downloadFile(url, destPath) {
	return new Promise((resolve, reject) => {
		const req = https.get(
			url,
			{ headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } },
			(res) => {
				if (res.statusCode !== 200) {
					reject(new Error(`download failed: HTTP ${res.statusCode}`));
					return;
				}
				const out = fs.createWriteStream(destPath);
				res.pipe(out);
				out.on("finish", () => out.close(resolve));
				out.on("error", reject);
			},
		);
		req.on("error", reject);
	});
}

// D-30: never auto-applied -- these are the only two entry points that
// write a model-proposed profile.md/dynamics.md change, and both
// require an explicit human button click to reach them at all.
async function resolveDiffTap({ action, body, client }) {
	if (!buttonResolve.claimTap(body)) return;
	try {
		const { outcomeText } = await handleDiffDecision({ action, body, client });
		await buttonResolve.resolveMessage({ client, body, outcomeText });
	} catch (err) {
		console.error(`${action.action_id} failed:`, err);
		await buttonResolve.resolveMessage({ client, body, outcomeText: "⚠️ Failed — check logs" });
	} finally {
		buttonResolve.releaseTap(body);
	}
}
app.action("profile_diff_approve", async ({ ack, action, body, client }) => {
	await ack();
	await resolveDiffTap({ action, body, client });
});
app.action("profile_diff_reject", async ({ ack, action, body, client }) => {
	await ack();
	await resolveDiffTap({ action, body, client });
});

// "Start a project from this idea" (build-guide-projects Part 15). The
// button's value is the chat session's thread_ts.
app.action(PROMOTE_ACTION_ID, async ({ ack, body, client }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		// value is the chat session's thread_ts. On the /chat root message the
		// value can't be known at post time, so fall back to the message's own
		// ts / thread_ts from the interaction payload.
		const raw = body.actions?.[0]?.value;
		const fromMsg = body.message?.thread_ts || body.message?.ts || body.container?.message_ts;
		const threadTs = raw && raw !== "PENDING" ? raw : fromMsg;
		const session = chatSession.getSession(threadTs);
		const channel = body.channel?.id;
		if (!session) {
			await buttonResolve.resolveMessage({
				client,
				body,
				outcomeText: "⚠️ Can't promote — lost the state for this chat (a restart, or already promoted)",
			});
			return;
		}
		const result = await promoteChat({ session, client, triggeredByUserId: body.user?.id });
		await buttonResolve.resolveMessage({
			client,
			body,
			outcomeText: result?.ok ? `✅ Promoted to \`${result.id}\`` : `⚠️ Promotion failed (${result?.reason || "unknown"})`,
		});
	} catch (err) {
		console.error("promote_chat action failed:", err);
		await buttonResolve.resolveMessage({ client, body, outcomeText: "⚠️ Promotion failed — check logs" });
	} finally {
		buttonResolve.releaseTap(body);
	}
});

// --- Prototype mount slot (Part 18.5) -------------------------------
function mountCtx(body, id) {
	const st = readState(id);
	return {
		client: app.client,
		channel: body.channel?.id || st?.channel_id,
		threadTs: st?.threads?.project,
	};
}
app.action("proto_mount", async ({ ack, body, client }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		const [id, touchN, min] = String(body.actions?.[0]?.value || "").split("::");
		const byUserId = body.user?.id;
		const byFounder = founderForUserId(byUserId);
		if (!byFounder || !id) return;
		await mountMod.mount({ id, touchN: Number(touchN), byFounder, minutes: Number(min), ...mountCtx(body, id) });
		await buttonResolve.resolveMessage({ client, body, outcomeText: `▶️ Mount requested by ${byFounder} — see below` });
	} catch (e) {
		console.error("proto_mount failed:", e);
		await buttonResolve.resolveMessage({ client, body, outcomeText: "⚠️ Mount failed — check logs" });
	} finally {
		buttonResolve.releaseTap(body);
	}
});
app.action("proto_dismount", async ({ ack, body, client }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		const id = body.actions?.[0]?.value;
		if (id) await mountMod.dismount({ id, reason: "manual", byUserId: body.user?.id, ...mountCtx(body, id) });
		await buttonResolve.resolveMessage({ client, body, outcomeText: "✅ Dismounted" });
	} catch (e) {
		console.error("proto_dismount failed:", e);
		await buttonResolve.resolveMessage({ client, body, outcomeText: "⚠️ Dismount failed — check logs" });
	} finally {
		buttonResolve.releaseTap(body);
	}
});
app.action("proto_extend", async ({ ack, body, client }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		const id = body.actions?.[0]?.value;
		if (id) await mountMod.extend({ id, ...mountCtx(body, id) });
		await buttonResolve.resolveMessage({ client, body, outcomeText: "✅ Extended — see below" });
	} catch (e) {
		console.error("proto_extend failed:", e);
		await buttonResolve.resolveMessage({ client, body, outcomeText: "⚠️ Extend failed — check logs" });
	} finally {
		buttonResolve.releaseTap(body);
	}
});
// D-51: `@Mill <cmd> <args>` in a thread runs the command immediately
// (slash commands don't work in threads; app_mention events do). Goes
// through command-shim.js -> the real handler, so every gate fires
// exactly as it would for a slash invocation. This is a *deliberate*
// invocation -- it does not go through the agent loop.
app.event("app_mention", async ({ event, client }) => {
	const founder = founderForUserId(event.user);
	if (!founder) return; // D-40
	const afterMention = String(event.text || "").replace(/<@[A-Z0-9]+>/i, "").trim();
	const parsed = parseMention(afterMention);
	const post = (text) =>
		client.chat.postMessage({ channel: event.channel, thread_ts: event.thread_ts || event.ts, text }).catch(() => {});
	if (!parsed) {
		await post("I can run: `@Mill attack`, `find <query>`, `cross`, `blindspot`, `themes`, `test`, `proto <assumption>`, `spinoff <idea>`, `audit`, `mode <name>`, `save`, `deck`. Or run the slash command from the channel body.");
		return;
	}
	// Change 1: mode switching is a control action on the project, not an
	// idea-lifecycle command -- handled directly rather than through
	// command-shim's HANDLERS map (dispatchCommand would 404 on "mode").
	if (parsed.action === "deck") {
		const project = findIdeaByChannel(event.channel);
		if (!project) {
			await post("`deck` renders a project's deck — it only works inside a project.");
			return;
		}
		const chatTs = event.thread_ts || null;
		if (!chatTs) {
			await post("Run `@Mill deck` inside a chat thread.");
			return;
		}
		// Fold the conversation into deck.md FIRST.
		//
		// The persona drafts slides in the thread; nothing writes the
		// document on a conversational turn. Without this, a founder who had
		// just worked through their slides in deck mode was told "there's no
		// deck.md yet — switch to deck mode and work through the slides",
		// which is both wrong and insulting when they are in deck mode and
		// have done exactly that. Consistent with D-57: syncing a document
		// from its own stage's conversation is bookkeeping, not an edit
		// needing approval, and the founder should not have to know
		// `@Mill save` exists to render what they just wrote.
		const { chatMode } = require("./chats");
		if (chatMode(project.id, chatTs) === "deck") {
			const note = await client.chat
				.postMessage({ channel: event.channel, thread_ts: chatTs, text: "_Folding this conversation into the deck…_" })
				.catch(() => null);
			const synced = await require("./doc-sync")
				.syncModeDocument({ id: project.id, mode: "deck", chatTs, client, channel: event.channel, threadTs: chatTs, announce: false })
				.catch((e) => {
					console.error(`deck: sync failed for ${project.id}: ${e.message}`);
					return { ok: false, reason: e.message };
				});
			if (note) {
				const line = synced.skipped
					? "_Deck already up to date with this chat._"
					: synced.ok
						? `_Deck updated from this chat${synced.before ? ` · ${synced.before} → ${synced.after} words` : ` · ${synced.after} words`}._`
						: `_Couldn't fold the conversation in: ${synced.reason}_`;
				await client.chat.update({ channel: event.channel, ts: note.ts, text: line }).catch(() => {});
			}
		}

		// Only now is "there is nothing to render" a true statement.
		if (!require("./mode-docs").readDoc(project.id, "deck")) {
			const inDeckMode = chatMode(project.id, chatTs) === "deck";
			await post(
				inDeckMode
					? "There's still nothing to render — we haven't worked out any slides in this chat yet. Tell me who a slide is for and what it should make them do, then `@Mill deck`."
					: "There's no `deck.md` for this project yet. Switch a chat to *deck* mode, work through the slides — who each one is for and what it should make them do — then `@Mill deck`.",
			);
			return;
		}
		await postDeckControl(client, project.id, chatTs, event.channel);
		return;
	}
	if (parsed.action === "save") {
		const project = findIdeaByChannel(event.channel);
		if (!project) {
			await post("`save` writes the current mode's document — it only works inside a project.");
			return;
		}
		const chatTs = event.thread_ts || null;
		const { chatMode } = require("./chats");
		const mode = chatTs ? chatMode(project.id, chatTs) : "brainstorm";
		const placeholder = await client.chat
			.postMessage({ channel: event.channel, thread_ts: chatTs, text: `_Writing the ${mode} document…_` })
			.catch(() => null);
		try {
			// Same path the agent's `save` tool takes, so `@Mill save` and
			// "write the product spec" cannot drift apart.
			const { runSaveForThread } = require("./mode-docflow");
			await runSaveForThread({
				id: project.id, mode, client,
				channel: event.channel, threadTs: chatTs,
				progressTs: placeholder ? placeholder.ts : null,
			});
		} catch (e) {
			console.error("save failed:", e);
			if (placeholder) await client.chat.update({ channel: event.channel, ts: placeholder.ts, text: `Save failed: ${e.message}` }).catch(() => {});
		}
		return;
	}
	if (parsed.action === "chat") {
		const project = findIdeaByChannel(event.channel);
		if (!project) {
			await post("`chat` opens a new chat inside a project channel. In `#chats`, use the `/chat` command.");
			return;
		}
		const title = String(parsed.rest || "").trim() || "Untitled chat";
		try {
			const { createChatCard } = require("./chat-card");
			const { chatTs } = await createChatCard(client, project.id, { title, createdBy: founder });
			await client.chat.postMessage({ channel: event.channel, thread_ts: chatTs, text: `_New chat opened by ${founder}. Reply in this thread._` }).catch(() => {});
		} catch (e) {
			console.error("chat create failed:", e);
			await post(`Couldn't open a chat: ${e.message}`);
		}
		return;
	}
	if (parsed.action === "mode") {
		const project = findIdeaByChannel(event.channel);
		if (!project) {
			await post("`mode` only works inside a project channel.");
			return;
		}
		const requested = String(parsed.rest || "").trim().toLowerCase();
		const result = await switchMode({
			id: project.id,
			mode: requested,
			client,
			channel: event.channel,
			chatTs: event.thread_ts || null, // the chat this was said in
			byFounder: founder,
		}).catch((e) => ({ ok: false, reason: e.message }));
		if (!result.ok) await post(`Can't switch mode: ${result.reason}`);
		return;
	}
	// Bug 1: immediate placeholder the command's result lands in.
	const onit = await client.chat
		.postMessage({ channel: event.channel, thread_ts: event.thread_ts || event.ts, text: `_On it — running \`/${parsed.action}\`…_` })
		.catch(() => null);
	await dispatchCommand({
		action: parsed.action,
		text: parsed.rest,
		channelId: event.channel,
		userId: event.user,
		threadTs: event.thread_ts,
		client,
		progressTs: onit?.ts || null,
		progressChannel: event.channel,
	}).catch((e) => console.error(`app_mention dispatch failed (${parsed.action}):`, e));
});

// I4: [Kill it] on a staleness nudge -- always reason `stale`.
app.action("stale_kill", async ({ ack, body, client }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		const id = body.actions?.[0]?.value;
		if (id) await killStale({ id, client: app.client });
		await buttonResolve.resolveMessage({ client, body, outcomeText: "✅ Killed (stale)" });
	} catch (e) {
		console.error("stale_kill failed:", e);
		await buttonResolve.resolveMessage({ client, body, outcomeText: "⚠️ Kill failed — check logs" });
	} finally {
		buttonResolve.releaseTap(body);
	}
});

// Change 1: one-tap mode switch. value is `<id>::<mode>`. Built on
// button-resolve from the start (Change 5's lesson: a tapped button must
// visibly resolve), not retrofitted after.
// The mode control: an overflow (⋮) on the pinned state card. Selecting a
// mode switches, and switchMode re-renders the card with the ✓ moved --
// that re-render IS the feedback, which is why this deliberately does NOT
// go through button-resolve: that strips a message's blocks, and the card
// is persistent and must keep its control.
app.action("mode_overflow", async ({ ack, body, client }) => {
	await ack();
	try {
		const [id, chatTs, mode] = String(body.actions?.[0]?.selected_option?.value || "").split("::");
		if (!id || !chatTs || !mode) return;
		const byFounder = founderForUserId(body.user?.id);
		const result = await switchMode({ id, chatTs, mode, client, channel: body.channel?.id, byFounder });
		if (!result.ok) {
			const st = readState(id);
			await client.chat
				.postMessage({ channel: body.channel?.id, thread_ts: st?.threads?.project, text: `Can't switch mode: ${result.reason}` })
				.catch(() => {});
		}
	} catch (e) {
		console.error("mode_overflow failed:", e);
	}
});

app.action(/^mode_switch/, async ({ ack, body, client }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		const [id, mode] = String(body.actions?.[0]?.value || "").split("::");
		const byFounder = founderForUserId(body.user?.id);
		const result = await switchMode({ id, mode, client, channel: body.channel?.id, threadTs: body.message?.thread_ts, byFounder });
		await buttonResolve.resolveMessage({
			client,
			body,
			outcomeText: result.ok ? `✅ Switched to *${mode}* — see banner below` : `⚠️ ${result.reason}`,
		});
	} catch (e) {
		console.error("mode_switch failed:", e);
		await buttonResolve.resolveMessage({ client, body, outcomeText: "⚠️ Mode switch failed — check logs" });
	} finally {
		buttonResolve.releaseTap(body);
	}
});

// --- deck rendering (D-56) --------------------------------------------
// `@Mill deck` posts the render control; the selects remember their
// choice on the chat; Render does the work with a progress message.
async function postDeckControl(client, id, chatTs, channel) {
	const deckRender = require("./deck-render");
	const gamma = require("./gamma");
	const themes = await gamma.listThemes().catch((e) => {
		console.error(`deck: listThemes failed: ${e.message}`);
		return [];
	});
	const settings = deckRender.deckSettings(id, chatTs);
	const { text, blocks } = deckRender.renderBlocks(id, chatTs, { themes, settings });
	await client.chat.postMessage({ channel, thread_ts: chatTs, text, blocks }).catch(() => {});
}

app.action("deck_theme", async ({ ack, body, client }) => {
	await ack();
	const [id, chatTs, themeId] = String(body.actions?.[0]?.selected_option?.value || "").split("::");
	if (id && chatTs) require("./deck-render").rememberSettings(id, chatTs, { deck_theme: themeId });
});
app.action("deck_textmode", async ({ ack, body }) => {
	await ack();
	const [id, chatTs, mode] = String(body.actions?.[0]?.selected_option?.value || "").split("::");
	if (id && chatTs) require("./deck-render").rememberSettings(id, chatTs, { deck_textmode: mode });
});
app.action("deck_images", async ({ ack, body }) => {
	await ack();
	const [id, chatTs, source] = String(body.actions?.[0]?.selected_option?.value || "").split("::");
	if (id && chatTs) require("./deck-render").rememberSettings(id, chatTs, { deck_images: source });
});
app.action("deck_export", async ({ ack, body }) => {
	await ack();
	const [id, chatTs, exportAs] = String(body.actions?.[0]?.selected_option?.value || "").split("::");
	if (id && chatTs) require("./deck-render").rememberSettings(id, chatTs, { deck_export: exportAs });
});
// ---- document questions: answer, write your own, or skip -------------
//
// An item that falls short for want of INFORMATION becomes a question
// with the answers already drafted, rather than a refusal the founder has
// to resolve in prose. Skip is not "leave it out" -- it means "you
// choose", and takes the top recommendation, which the message says
// before it is tapped and the resolved message records after.
async function answerDocQuestion({ body, client, index, answer, skipped, id, chatTs }) {
	const { recordAnswer, completeIfDone, outstanding, getPending } = require("./doc-questions");
	recordAnswer(id, chatTs, index, answer, { skipped });
	await buttonResolve.resolveMessage({
		client, body,
		outcomeText: skipped ? `Skipped — used: ${answer}` : `Answered: ${answer}`,
	});
	const left = outstanding(getPending(id, chatTs));
	if (left === 0) {
		await completeIfDone({ id, chatTs, client, channel: body.channel?.id }).catch((e) =>
			console.error(`docq: re-save failed for ${id}: ${e.message}`),
		);
	}
}

app.action(/^docq_pick_/, async ({ ack, body, client, action }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		const [id, chatTs, index, opt] = String(action.value).split("::");
		const item = require("./doc-questions").getPending(id, chatTs)?.items?.[Number(index)];
		const chosen = item?.options?.[Number(opt)];
		if (!chosen) return;
		await answerDocQuestion({ body, client, index: Number(index), answer: chosen.answer, skipped: false, id, chatTs });
	} catch (e) {
		console.error("docq_pick failed:", e?.data?.error || e.message);
	} finally {
		buttonResolve.releaseTap(body);
	}
});

app.action("docq_skip", async ({ ack, body, client, action }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		const [id, chatTs, index] = String(action.value).split("::");
		const item = require("./doc-questions").getPending(id, chatTs)?.items?.[Number(index)];
		const top = item?.options?.[0];
		if (!top) return;
		await answerDocQuestion({ body, client, index: Number(index), answer: top.answer, skipped: true, id, chatTs });
	} catch (e) {
		console.error("docq_skip failed:", e?.data?.error || e.message);
	} finally {
		buttonResolve.releaseTap(body);
	}
});

app.action("docq_custom", async ({ ack, body, client, action }) => {
	await ack();
	try {
		const [id, chatTs, index] = String(action.value).split("::");
		const item = require("./doc-questions").getPending(id, chatTs)?.items?.[Number(index)];
		if (!item) return;
		// The message keeps its buttons until the modal is submitted --
		// opening a dialog is not an answer, and cancelling must leave the
		// question still answerable.
		await client.views.open({
			trigger_id: body.trigger_id,
			view: require("./doc-questions").customModal({ id, chatTs, index: Number(index), item }),
		});
	} catch (e) {
		console.error("docq_custom failed:", e?.data?.error || e.message);
	}
});

app.view("docq_custom_modal", async ({ ack, body, view, client }) => {
	await ack();
	try {
		const [id, chatTs, index] = String(view.private_metadata).split("::");
		const answer = view.state?.values?.docq_answer?.value?.value?.trim();
		if (!answer) return;
		const { recordAnswer, completeIfDone, outstanding, getPending } = require("./doc-questions");
		recordAnswer(id, chatTs, Number(index), answer, { skipped: false });
		// No `body.message` on a view submission, so the question message
		// cannot be resolved in place the way a button tap resolves it.
		// Post the answer into the thread instead, which is honest about
		// what happened and keeps the record in one place.
		const channel = readState(id)?.channel_id;
		if (!channel) {
			console.error(`docq_custom_modal: no channel_id on ${id}; answer recorded but not posted`);
			return;
		}
		await client.chat.postMessage({ channel, thread_ts: chatTs, text: `_Answered:_ ${answer}` }).catch(() => {});
		if (outstanding(getPending(id, chatTs)) === 0) {
			await completeIfDone({ id, chatTs, client, channel }).catch((e) =>
				console.error(`docq: re-save failed for ${id}: ${e.message}`),
			);
		}
	} catch (e) {
		console.error("docq_custom_modal failed:", e?.data?.error || e.message);
	}
});

app.action("deck_browse", async ({ ack, body, client }) => {
	await ack();
	try {
		const [id, chatTs] = String(body.actions?.[0]?.value || "").split("::");
		const themes = await require("./gamma").listThemes();
		await client.views.open({ trigger_id: body.trigger_id, view: require("./deck-render").themeModal(id, chatTs, themes) });
	} catch (e) {
		console.error("deck_browse failed:", e?.data?.error || e.message);
	}
});
app.action("deck_pick", async ({ ack, body, client }) => {
	await ack();
	const [id, chatTs, themeId] = String(body.actions?.[0]?.value || "").split("::");
	if (!id || !chatTs) return;
	require("./deck-render").rememberSettings(id, chatTs, { deck_theme: themeId });
	// Confirm INSIDE the modal. Posting to the channel instead left the
	// founder staring at an unchanged list of themes with no sign the tap
	// registered -- they cannot see the thread while the modal is open.
	const viewId = body.view?.id;
	if (viewId) {
		await client.views
			.update({
				view_id: viewId,
				view: {
					type: "modal",
					title: { type: "plain_text", text: "Deck themes" },
					close: { type: "plain_text", text: "Done" },
					blocks: [
						{ type: "section", text: { type: "mrkdwn", text: `✅ Theme set to *${themeId}*.` } },
						{ type: "context", elements: [{ type: "mrkdwn", text: "Close this and hit *Render* in the thread." }] },
					],
				},
			})
			.catch((e) => console.error("deck_pick: view update failed:", e?.data?.error || e.message));
	}
});
app.action("deck_render_go", async ({ ack, body, client }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		const [id, chatTs] = String(body.actions?.[0]?.value || "").split("::");
		const st = readState(id);
		const channel = body.channel?.id || st?.channel_id;
		await buttonResolve.resolveMessage({ client, body, outcomeText: "▶️ Rendering…" });
		const progress = await client.chat
			.postMessage({ channel, thread_ts: chatTs, text: "_Rendering…_" })
			.then((r) => r.ts)
			.catch(() => null);
		const result = await require("./deck-render").renderDeck({ id, chatTs, client, channel, progressTs: progress });
		if (!result.ok && progress) {
			await client.chat.update({ channel, ts: progress, text: `Couldn't render: ${result.reason}` }).catch(() => {});
		}
	} catch (e) {
		console.error("deck_render_go failed:", e);
	} finally {
		buttonResolve.releaseTap(body);
	}
});

// The auto-gen decision on the first message in a mode whose input
// document is missing (mode-entry.js). "Yes" drafts it with a visible
// thinking message; "no" switches THIS chat to the missing stage, keeping
// the conversation in one thread rather than starting a fresh one.
app.action("autogen_yes", async ({ ack, body, client }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		const [id, chatTs, missingMode] = String(body.actions?.[0]?.value || "").split("::");
		const { clearPending } = require("./mode-entry");
		clearPending(id, chatTs);
		await buttonResolve.resolveMessage({ client, body, outcomeText: `⏳ Drafting the ${missingMode} document…` });
		const st = readState(id);
		const channel = body.channel?.id || st?.channel_id;
		const { generateMissingDoc } = require("./mode-docflow");
		const { threadContextText } = require("./command-shim");
		const result = await generateMissingDoc({
			id, mode: missingMode, client, channel, threadTs: chatTs,
			// The upstream document was just synced by mode-entry, so this is
			// belt-and-braces rather than the primary source.
			threadContext: threadContextText(chatTs, channel),
		});
		if (!result.ok && !result.refusal) {
			await client.chat.postMessage({ channel, thread_ts: chatTs, text: `Couldn't draft it: ${result.reason}` }).catch(() => {});
		}
		const { touchAndRepin } = require("./chat-card");
		await touchAndRepin(client, id, chatTs).catch(() => {});
	} catch (e) {
		console.error("autogen_yes failed:", e);
	} finally {
		buttonResolve.releaseTap(body);
	}
});
app.action("autogen_no", async ({ ack, body, client }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		const [id, chatTs, missingMode] = String(body.actions?.[0]?.value || "").split("::");
		const { clearPending } = require("./mode-entry");
		clearPending(id, chatTs);
		const byFounder = founderForUserId(body.user?.id);
		const result = await switchMode({ id, chatTs, mode: missingMode, client, channel: body.channel?.id, byFounder });
		await buttonResolve.resolveMessage({
			client, body,
			outcomeText: result.ok ? `✅ Switched this chat to *${missingMode}*` : `⚠️ ${result.reason}`,
		});
	} catch (e) {
		console.error("autogen_no failed:", e);
		await buttonResolve.resolveMessage({ client, body, outcomeText: "⚠️ Switch failed — check logs" });
	} finally {
		buttonResolve.releaseTap(body);
	}
});

// Change 3: missing/stale document buttons. All built on button-resolve
// from the start, same as mode_switch.
app.action("generate_doc", async ({ ack, body, client }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		const [id, mode] = String(body.actions?.[0]?.value || "").split("::");
		const st = readState(id);
		const { generateMissingDoc } = require("./mode-docflow");
		const { threadContextText } = require("./command-shim");
		const channel = body.channel?.id || st?.channel_id;
		const threadTs = body.message?.thread_ts || st?.threads?.project;
		const result = await generateMissingDoc({
			id,
			mode,
			client,
			channel,
			threadTs,
			// Generate from what was actually DISCUSSED, not just from the
			// upstream document. generateMissingDoc has always accepted this
			// and was never given it, so a spec generated on leaving a mode
			// read as though the conversation in it had never happened.
			threadContext: threadContextText(threadTs, channel),
		});
		await buttonResolve.resolveMessage({
			client,
			body,
			outcomeText: result.ok ? `✅ Generated — see below` : `⚠️ Couldn't generate (${result.reason})`,
		});
	} catch (e) {
		console.error("generate_doc failed:", e);
		await buttonResolve.resolveMessage({ client, body, outcomeText: "⚠️ Generate failed — check logs" });
	} finally {
		buttonResolve.releaseTap(body);
	}
});
app.action("regenerate_stale", async ({ ack, body, client }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		const [id, mode] = String(body.actions?.[0]?.value || "").split("::");
		const st = readState(id);
		const { regenerateStaleSections } = require("./mode-docflow");
		const result = await regenerateStaleSections({
			id,
			mode,
			client,
			channel: body.channel?.id || st?.channel_id,
			threadTs: body.message?.thread_ts || st?.threads?.project,
		});
		await buttonResolve.resolveMessage({
			client,
			body,
			outcomeText: result.ok ? `✅ Regenerated stale sections — see below` : `⚠️ ${result.reason}`,
		});
	} catch (e) {
		console.error("regenerate_stale failed:", e);
		await buttonResolve.resolveMessage({ client, body, outcomeText: "⚠️ Regenerate failed — check logs" });
	} finally {
		buttonResolve.releaseTap(body);
	}
});
// Change 4: the pre-proto audit suggestion. Recorded (audit_suggested)
// at post time in mode-switch.js, not on tap -- these two buttons are
// purely for the founder's convenience and don't affect whether the
// suggestion repeats.
app.action("audit_suggestion_switch", async ({ ack, body, client }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		const id = body.actions?.[0]?.value;
		const byFounder = founderForUserId(body.user?.id);
		const result = await switchMode({ id, mode: "audit", client, channel: body.channel?.id, threadTs: body.message?.thread_ts, byFounder });
		await buttonResolve.resolveMessage({
			client,
			body,
			outcomeText: result.ok ? "✅ Switched to audit — see banner below" : `⚠️ ${result.reason}`,
		});
	} catch (e) {
		console.error("audit_suggestion_switch failed:", e);
		await buttonResolve.resolveMessage({ client, body, outcomeText: "⚠️ Switch failed — check logs" });
	} finally {
		buttonResolve.releaseTap(body);
	}
});
app.action("audit_suggestion_dismiss", async ({ ack, body, client }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		await buttonResolve.resolveMessage({ client, body, outcomeText: "👍 Continuing without an audit" });
	} finally {
		buttonResolve.releaseTap(body);
	}
});

app.action("stale_ack", async ({ ack, body, client }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		await buttonResolve.resolveMessage({ client, body, outcomeText: "👍 Left as-is — update it yourself when ready" });
	} finally {
		buttonResolve.releaseTap(body);
	}
});

app.action("proto_takeover", async ({ ack, body, client }) => {
	await ack();
	if (!buttonResolve.claimTap(body)) return;
	try {
		const [id, touchN, min] = String(body.actions?.[0]?.value || "").split("::");
		const byFounder = founderForUserId(body.user?.id);
		if (!byFounder || !id) return;
		const held = mountMod.findMountedIdea();
		if (held) {
			await mountMod
				.dismount({ id: held.id, client: app.client, channel: held.channel_id, threadTs: held.threads?.project, reason: `taken over by ${byFounder} for \`${id}\`` })
				.catch((e) => console.error("takeover dismount failed:", e));
		}
		await mountMod.mount({ id, touchN: Number(touchN), byFounder, minutes: Number(min), ...mountCtx(body, id) });
		await buttonResolve.resolveMessage({ client, body, outcomeText: `▶️ Taken over by ${byFounder} — see below` });
	} catch (e) {
		console.error("proto_takeover failed:", e);
		await buttonResolve.resolveMessage({ client, body, outcomeText: "⚠️ Takeover failed — check logs" });
	} finally {
		buttonResolve.releaseTap(body);
	}
});

app.message(async ({ message, client }) => {
	// A pending /test field-evidence wait takes priority over anything
	// else a message could be -- if consumed here, it's not a capture
	// even if it happened to arrive in a DM.
	if (handleThreadMessage(message)) return;

	// A file uploaded into a project channel is a document (Part 17).
	// A comment attached to an upload is still a message. Storing the files
	// used to consume the turn, so "here are five slides — make me something
	// similar" got a ✅ and no reply: the instruction vanished behind a tick
	// that reads as "understood". Files are stored first, then anything the
	// founder actually said falls through to the persona, with the new
	// documents already in context.
	if (message.subtype === "file_share") {
		const stored = await handleProjectUpload({ message, client });
		if (stored && !(message.text || "").trim()) return; // files only, nothing said
	}

	// A message in a #chats session thread is a conversational turn, not
	// a capture (build-guide-projects 14.3 -- these paths never collapse).
	if (await handleChatTurn({ message, client })) return;

	// Only DMs are captures. Ignore channel messages, edits, deletes, bot
	// messages and anything without a plain user text body.
	if (message.channel_type !== "im") return;
	if (message.subtype) return;
	if (!message.user) return;

	const founder = founderForUserId(message.user);
	if (!founder) return; // D-40: silent, no reply, no file

	try {
		const audioFiles = (message.files || []).filter((f) =>
			(f.mimetype || "").startsWith("audio/"),
		);

		if (audioFiles.length > 0) {
			// Voice capture: native-audio transcription via Gemini 3.7
			// Flash (D-36) is command-adjacent logic, out of scope for
			// Part 9's transport-only pass. Save the raw audio so
			// nothing is lost, and leave a placeholder capture line
			// pointing at it for Part 9b to pick up.
			const audioDir = path.join(MINDS_DIR, founder, "captures", "audio");
			fs.mkdirSync(audioDir, { recursive: true });
			for (const f of audioFiles) {
				const destName = `${Date.now()}-${f.name || f.id}`;
				const dest = path.join(audioDir, destName);
				await downloadFile(f.url_private, dest);
				writeCapture(
					founder,
					`[voice note saved to captures/audio/${destName} — transcription pending, see Part 9b]`,
				);
			}
		}

		const text = (message.text || "").trim();
		if (text) {
			writeCapture(founder, text);
		}

		if (audioFiles.length > 0 || text) {
			await client.reactions.add({
				channel: message.channel,
				timestamp: message.ts,
				name: "white_check_mark",
			});
		}
	} catch (err) {
		console.error("capture failed:", err);
	}
});

(async () => {
	await app.start();
	console.log("mill-chat: Slack bot connected (Socket Mode)");

	// Turn a wedged Socket Mode connection into a dead process so systemd
	// (Restart=always) rebuilds it -- see socket-health.js for the full
	// rationale (2026-08-27 reboot: socket alive, events silently dropped).
	startSocketHealth({ app });

	// #chats session state is mirrored to disk (outside the repo) so a
	// restart doesn't lose raw thinking -- reload it (build-guide-projects
	// Part 14.2/14.7).
	const restored = chatSession.loadAll();
	console.log(`chat-session: restored ${restored} session(s) from disk`);

	// Part 18.6: reconcile the mount slot against the actually-running
	// container, not stale state.json.
	mountMod
		.reconcileOnStartup(app.client)
		.then((r) => console.log(`mount: reconcile -> ${JSON.stringify(r)}`))
		.catch((e) => console.error(`mount: reconcile failed: ${e.message}`));

	startBatchCommitLoop((reason) => {
		console.error(`batch commit failed: ${reason}`);
	});

	// 20:00 UTC (01:30 IST): append each founder's own messages from
	// unpromoted chats to their captures file (Part 14.7). In-process, not
	// cron, for the same reason weekly profile evolution is.
	startNightlyScheduler((reason) => console.error(`nightly chat capture failed: ${reason}`));

	// I4: daily staleness sweep -- nudge ideas stuck pre-verdict for 14/30
	// days, once each. In-process, same reason as the other schedulers.
	startStalenessSweep(app.client, (reason) => console.error(`staleness sweep failed: ${reason}`));

	// Sunday 09:30 IST (04:00 UTC), D-30: proposes profile/dynamics diffs,
	// never applies them -- see profile-evolution.js and the
	// profile_diff_approve/reject action handlers above.
	startWeeklyScheduler(
		() => runWeeklyProfileEvolution(app.client),
		(reason) => console.error(`weekly profile evolution failed: ${reason}`),
	);

	// Reload the allowlist/channel map from disk on SIGHUP, so adding a
	// founder (or fixing a channel id) later is just editing
	// ~/.config/mill/env and `systemctl kill -s HUP mill-chat` -- no code
	// change, no full restart needed. A plain `systemctl restart` also
	// picks up the change, since config.load() runs at require time too.
	process.on("SIGHUP", () => {
		console.log("SIGHUP received, reloading config");
		config.load();
	});

	for (const sig of ["SIGINT", "SIGTERM"]) {
		process.on(sig, async () => {
			console.log(`${sig} received, flushing pending captures before exit`);
			await commitCaptures((reason) =>
				console.error(`final commit failed: ${reason}`),
			);
			process.exit(0);
		});
	}
})();
