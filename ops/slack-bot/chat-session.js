"use strict";

// Chat-tier session state (docs/PROJECTS.md "Chats", build-guide-projects
// Part 14.2/14.6). A session is one thread in #chats: a running
// conversation plus the founder's profile and recent captures as context.
//
// Keyed on thread_ts, never on channel -- #chats holds many parallel
// sessions and channel-level binding would bleed context between them
// (PROJECTS.md 14.2/14.3, build-guide 14.2).
//
// Not repo state -- chats are disposable (PROJECTS.md: "Chat is cheap and
// disposable"). The full transcript enters the repo only on promotion
// (Part 15). But raw thinking must not be lost to a bot restart, so
// sessions are mirrored to ~/.cache/mill/chat-sessions/<ts>.json (outside
// the repo) and reloaded on startup; the nightly job (Part 14.7) appends
// each founder's own turns to their captures file regardless.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { callFlash } = require("./llm");
const { readProfile, readCaptures, hasProfile } = require("./context");
const { channelId } = require("./config");
const { withPromoteButton } = require("./promote-button");
const { findIdeaByChannel, updateState, readOriginChat, readIdeaMd } = require("./ideas");

// A promoted idea's stage threads must see where the chat that spawned
// them got to (ROOT CAUSE B). origin-chat.md is the full transcript;
// idea.md carries the distilled summary + assumption. Both go in the
// cached prefix. Cap the raw transcript so a marathon chat doesn't blow
// the context budget -- past the cap, the idea.md summary alone carries
// it (that's what the summary is for).
const ORIGIN_CHAT_CHAR_CAP = Number(process.env.MILL_ORIGIN_CHAT_CHAR_CAP) || 24000;

function readOriginContext(ideaId) {
	if (!ideaId) return "";
	const parts = [];
	const ideaMd = readIdeaMd(ideaId);
	if (ideaMd && ideaMd.trim()) parts.push(`idea.md (origin, summary, assumption):\n\n${ideaMd.trim()}`);
	const chat = readOriginChat(ideaId);
	if (chat && chat.trim()) {
		const trimmed =
			chat.length > ORIGIN_CHAT_CHAR_CAP
				? `${chat.slice(0, ORIGIN_CHAT_CHAR_CAP)}\n\n_[origin chat truncated for context; full transcript in ideas/${ideaId}/origin-chat.md]_`
				: chat;
		parts.push(`Origin chat transcript (the conversation this project was promoted from):\n\n${trimmed}`);
	}
	return parts.join("\n\n---\n\n");
}
const { COMMAND_STAGE, repostAnchors } = require("./project-channel");
const { postResult } = require("./reply");

const STORE_DIR =
	process.env.MILL_CHAT_STORE_DIR ||
	path.join(os.homedir(), ".cache", "mill", "chat-sessions");

// Compaction (build-guide 14.6): at COMPACT_AT turns, summarise all but
// the last KEEP_VERBATIM into a compact block; repeat every COMPACT_AT.
const COMPACT_AT = Number(process.env.MILL_CHAT_COMPACT_AT) || 30;
const KEEP_VERBATIM = Number(process.env.MILL_CHAT_KEEP_VERBATIM) || 10;

const CONTEXT_SYSTEM_PROMPT = [
	"You are Mill, a thinking partner for a startup founder working an idea out loud in a chat.",
	"Engage with what they actually said. Push on weak points, ask for the number or the named alternative when a claim is vague, follow the thread they're on.",
	"This is a chat, not a report: be concise, no headings, no bullet-point essays unless they ask.",
	"Nothing here is stored unless they promote it to a project.",
].join("\n");

/** @type {Map<string, object>} thread_ts -> session */
const sessions = new Map();

function sessionPath(threadTs) {
	return path.join(STORE_DIR, `${threadTs}.json`);
}

function persist(session) {
	try {
		fs.mkdirSync(STORE_DIR, { recursive: true });
		fs.writeFileSync(sessionPath(session.threadTs), JSON.stringify(session), "utf8");
	} catch (err) {
		console.error(`chat-session: persist failed for ${session.threadTs}: ${err.message}`);
	}
}

function loadAll() {
	let files;
	try {
		files = fs.readdirSync(STORE_DIR).filter((f) => f.endsWith(".json"));
	} catch {
		return 0;
	}
	let n = 0;
	for (const f of files) {
		try {
			const s = JSON.parse(fs.readFileSync(path.join(STORE_DIR, f), "utf8"));
			if (s && s.threadTs) {
				sessions.set(s.threadTs, s);
				n += 1;
			}
		} catch (err) {
			console.error(`chat-session: could not load ${f}: ${err.message}`);
		}
	}
	return n;
}

function createSession({ threadTs, channel, ownerUserId, ownerFounder, topic }) {
	const session = {
		threadTs,
		channel,
		ownerUserId,
		ownerFounder,
		topic: topic || "",
		turns: [], // {role: 'user'|'assistant', text, userId, ts}
		summary: null, // compacted older turns, or null
		compactedThrough: 0, // count of turns folded into `summary`
		flushedThrough: 0, // count of turns already appended to captures (Part 14.7)
		promoted: false,
		createdAt: Date.now(),
	};
	sessions.set(threadTs, session);
	persist(session);
	return session;
}

function getSession(threadTs) {
	return threadTs ? sessions.get(threadTs) || null : null;
}

// Project stage threads (16.3): a plain message in a project channel's
// Brainstorm/Research/etc. thread is a conversational turn scoped to
// THAT thread. Each stage thread gets its own session keyed on its ts,
// so research findings in the Research thread never bleed into a
// Brainstorm reply in the same channel. Returns null if the message
// isn't in a recognised stage thread.
function getOrCreateStageSession({ project, threadTs, channel, speakerUserId, speakerFounder }) {
	if (!project || !project.threads) return null;
	const entry = Object.entries(project.threads).find(([, ts]) => ts === threadTs);
	if (!entry) return null;
	const stage = entry[0];

	let session = sessions.get(threadTs);
	if (session) return session;

	session = {
		threadTs,
		channel,
		kind: "project",
		ideaId: project.id,
		stage,
		ownerUserId: speakerUserId,
		ownerFounder: project.founder || speakerFounder,
		topic: project.assumption
			? `${stage} thread for idea ${project.id}. Assumption under test: ${project.assumption}`
			: `${stage} thread for idea ${project.id} (no assumption set yet)`,
		turns: [],
		summary: null,
		compactedThrough: 0,
		flushedThrough: 0,
		promoted: true, // a promoted idea -- nightly chat-capture skips it
		createdAt: Date.now(),
	};
	sessions.set(threadTs, session);
	persist(session);
	return session;
}

// Slash commands don't carry thread_ts, so a `/find` or `/attack` run
// from #chats can't be tied to a thread by the payload. Fall back to the
// founder's most recently created, unpromoted session in that channel --
// in practice that's the one they're actively in.
function findLatestSessionForUser(userId, channel) {
	let best = null;
	for (const s of sessions.values()) {
		if (s.promoted) continue;
		if (s.ownerUserId !== userId) continue;
		if (channel && s.channel !== channel) continue;
		if (!best || s.createdAt > best.createdAt) best = s;
	}
	return best;
}

function addTurn(session, { role, text, userId, ts }) {
	session.turns.push({ role, text, userId: userId || null, ts: ts || null });
	persist(session);
	return session;
}

function markPromoted(threadTs) {
	const s = sessions.get(threadTs);
	if (s) {
		s.promoted = true;
		persist(s);
	}
}

// Builds the message array for a conversational turn: stable content
// first (system, profile, captures, running summary) so the prefix
// caches, volatile last (recent verbatim turns).
function buildContextMessages(session) {
	const messages = [{ role: "system", content: CONTEXT_SYSTEM_PROMPT }];

	if (hasProfile(session.ownerFounder)) {
		messages.push({
			role: "system",
			content: `Founder profile (how they fail):\n\n${readProfile(session.ownerFounder)}`,
		});
	}

	const captures = readCaptures(session.ownerFounder, { maxEntries: 20, maxTokens: 8000 });
	if (captures.length) {
		messages.push({
			role: "system",
			content: `Recent captures from this founder:\n\n${captures.join("\n")}`,
		});
	}

	// Project stage thread: load the origin chat so the thread isn't
	// starting from nothing (ROOT CAUSE B). Stable within a session, so it
	// belongs in the cached prefix beside the profile.
	if (session.kind === "project" && session.ideaId) {
		const origin = readOriginContext(session.ideaId);
		if (origin) {
			messages.push({
				role: "system",
				content:
					`This is the *${session.stage || "project"}* thread for idea ${session.ideaId}. ` +
					`The conversation so far in THIS thread is below; the project's origin is here:\n\n${origin}`,
			});
		}
	}

	if (session.topic) {
		messages.push({ role: "system", content: `Chat topic: ${session.topic}` });
	}

	if (session.summary) {
		messages.push({
			role: "system",
			content: `Summary of earlier turns in this chat (compacted):\n\n${session.summary}`,
		});
	}

	// Verbatim turns not yet folded into the summary.
	for (const turn of session.turns.slice(session.compactedThrough)) {
		messages.push({ role: turn.role, content: turn.text });
	}
	return messages;
}

// build-guide 14.6: at COMPACT_AT turns, summarise turns [compactedThrough
// .. len-KEEP_VERBATIM) into `summary`, keep the last KEEP_VERBATIM
// verbatim. The summary MUST preserve any assumption, number, or named
// alternative -- those are what /attack and promotion depend on.
// Returns a marker string to post in-thread, or null if nothing compacted.
async function maybeCompact(session) {
	const uncompacted = session.turns.length - session.compactedThrough;
	if (uncompacted < COMPACT_AT) return null;

	const foldEnd = session.turns.length - KEEP_VERBATIM;
	const toFold = session.turns.slice(session.compactedThrough, foldEnd);
	if (toFold.length === 0) return null;

	const transcript = toFold
		.map((t) => `${t.role === "user" ? "Founder" : "Mill"}: ${t.text}`)
		.join("\n\n");

	const messages = [
		{
			role: "system",
			content: [
				"Compress this chat excerpt into a compact summary a thinking partner can carry forward.",
				"MUST preserve verbatim: every assumption stated, every number (price, percentage, count), every named competitor or alternative, every decision reached.",
				"Drop small talk and repetition. No preamble.",
			].join("\n"),
		},
		{ role: "user", content: transcript },
	];

	let summaryText;
	try {
		const { content } = await callFlash(messages, { model: "flash-fast", maxTokens: 2048 });
		summaryText = (content || "").trim();
	} catch (err) {
		console.error(`chat-session: compaction call failed for ${session.threadTs}: ${err.message}`);
		return null; // leave the session uncompacted; try again next turn
	}
	if (!summaryText) return null;

	session.summary = session.summary
		? `${session.summary}\n\n--- continued ---\n\n${summaryText}`
		: summaryText;
	session.compactedThrough = foldEnd;
	persist(session);

	return `_🗜️ Compacted turns ${1}–${foldEnd} to keep this chat cheap. Assumptions, numbers and named alternatives were preserved. Full transcript is kept if you promote this._`;
}

// Full transcript for promotion (Part 15) -- origin-chat.md gets
// everything, never the compacted view.
function fullTranscript(session) {
	const lines = [];
	if (session.topic) lines.push(`# Chat — ${session.topic}`, "");
	for (const t of session.turns) {
		lines.push(`**${t.role === "user" ? "Founder" : "Mill"}:** ${t.text}`, "");
	}
	return lines.join("\n");
}

// Part 14.7: each founder's OWN messages from unpromoted chats, not yet
// flushed. Returns [{founder, lines: [...]}] and advances flushedThrough.
function drainForNightlyCapture() {
	const out = [];
	for (const session of sessions.values()) {
		if (session.promoted) continue;
		const fresh = session.turns
			.slice(session.flushedThrough)
			.filter((t) => t.role === "user" && t.userId === session.ownerUserId && t.text.trim());
		session.flushedThrough = session.turns.length;
		persist(session);
		if (fresh.length) {
			out.push({
				founder: session.ownerFounder,
				lines: fresh.map((t) => t.text.trim()),
			});
		}
	}
	return out;
}

// Where a brainstorm command's output should go, given its slash-command
// payload. In #chats it threads into the founder's active session (and
// the caller records the exchange as turns); anywhere else it's the
// invoking channel, falling back to #mill-ideas. build-guide-projects
// 14.3/14.4: these paths never collapse.
function commandDestination(command) {
	const chatsChannel = channelId("chats");
	const millChannel = channelId("mill");
	if (command.channel_id === chatsChannel) {
		// D-51: an `@Mill <cmd>` or a tapped offer carries the exact thread
		// it came from -- prefer that session over "the founder's latest",
		// which is only a fallback for a real slash command (no thread_ts).
		const session =
			(command.thread_ts && getSession(command.thread_ts)) ||
			findLatestSessionForUser(command.user_id, chatsChannel);
		return {
			channel: chatsChannel,
			threadTs: session ? session.threadTs : undefined,
			session,
			inChat: true,
		};
	}

	// Project channel (Part 16.3): every command posts into its stage
	// thread, keyed on thread_ts. If the stage thread_ts is missing/stale
	// the caller (postCommandResult / ensureStageThread) reposts anchors
	// rather than ever posting to channel root.
	const project = command.channel_id ? findIdeaByChannel(command.channel_id) : null;
	if (project) {
		const stage = COMMAND_STAGE[command.command] || "brainstorm";
		return {
			channel: command.channel_id,
			threadTs: project.threads ? project.threads[stage] : undefined,
			session: null,
			inChat: false,
			project,
			stage,
		};
	}

	return {
		channel: command.channel_id || millChannel,
		threadTs: undefined,
		session: null,
		inChat: false,
	};
}

// Ensures a project stage thread exists; reposts all anchors and
// persists the fresh map into state.json if it's missing (16.3: never
// post to channel root). Mutates `dest.threadTs` and returns it.
async function ensureStageThread(client, dest) {
	if (!dest.project || dest.threadTs) return dest.threadTs;
	const fresh = await repostAnchors({
		client,
		channel: dest.channel,
		assumption: dest.project.assumption,
	});
	try {
		updateState(dest.project.id, { threads: fresh });
	} catch (err) {
		console.error(`ensureStageThread: state update failed for ${dest.project.id}: ${err.message}`);
	}
	dest.project.threads = fresh;
	dest.threadTs = fresh[dest.stage] || fresh.brainstorm;
	return dest.threadTs;
}

// Posts a command's result to the resolved destination, threading it and
// recording it as session turns when the command ran inside a #chats
// session. `invocation` is the raw command text ("/think foo") recorded
// as the user turn.
async function postCommandResult(client, dest, { text, invocation, userId }) {
	// Project channel: make sure the stage thread exists before posting.
	if (dest.project && !dest.threadTs) await ensureStageThread(client, dest);

	const msg = { channel: dest.channel, text };
	if (dest.threadTs) msg.thread_ts = dest.threadTs;
	// 15.1: every bot reply in a chat thread carries the promote button.
	if (dest.session) msg.blocks = withPromoteButton(text, dest.session.threadTs);
	// Bug 1: land in the "On it — running /x…" placeholder when there is
	// one (reply.js). Falls back to a plain post otherwise.
	const posted = await postResult(client, msg);
	if (dest.session) {
		if (invocation) addTurn(dest.session, { role: "user", text: invocation, userId: userId || null });
		addTurn(dest.session, { role: "assistant", text });
	}
	return posted;
}

module.exports = {
	loadAll,
	createSession,
	getSession,
	getOrCreateStageSession,
	findLatestSessionForUser,
	commandDestination,
	ensureStageThread,
	postCommandResult,
	addTurn,
	markPromoted,
	buildContextMessages,
	readOriginContext,
	maybeCompact,
	fullTranscript,
	drainForNightlyCapture,
	sessions,
	COMPACT_AT,
	KEEP_VERBATIM,
};
