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
const { emit } = require("./telemetry");
const { buildEvalEvent } = require("./eval-event");
const { readProfile, readCaptures, hasProfile } = require("./context");
const { channelId } = require("./config");
const { findIdeaByChannel, updateState, readOriginChat, readIdeaMd, readFindIndex } = require("./ideas");

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
	// D-53: surface-search reports run in any thread of this project are
	// referenceable from all of them. The index is small; the full text
	// of a report lives at the path it names.
	const findIdx = readFindIndex(ideaId);
	if (findIdx && findIdx.trim()) {
		parts.push(
			`Surface-search reports in this project (NOT evidence — never cite as such; only /test produces evidence). ` +
				`Cite one by its path if relevant:\n\n${findIdx.trim().slice(0, 6000)}`,
		);
	}
	return parts.join("\n\n---\n\n");
}

const { postResult } = require("./reply");

const STORE_DIR =
	process.env.MILL_CHAT_STORE_DIR ||
	path.join(os.homedir(), ".cache", "mill", "chat-sessions");

// Compaction (build-guide 14.6): at COMPACT_AT turns, summarise all but
// the last KEEP_VERBATIM into a compact block; repeat every COMPACT_AT.
const COMPACT_AT = Number(process.env.MILL_CHAT_COMPACT_AT) || 30;
const KEEP_VERBATIM = Number(process.env.MILL_CHAT_KEEP_VERBATIM) || 10;

// STYLE ONLY -- deliberately asserts no identity.
//
// This used to open "You are Mill, a thinking partner..." and instruct
// "Engage with what they actually said", which is close to the inverse of
// "refuse". Together with the agent's own "You are Mill" opener it meant
// three system messages each claiming a different role, and the persona --
// the one that defines what this mode will not accept -- lost. Identity is
// now single-sourced from personas.js; this contributes tone only. (The old
// "nothing here is stored" line was also simply false inside a project.)
const CONTEXT_SYSTEM_PROMPT = [
	"Style: this is a chat, not a report. Be concise; no headings or bullet-point essays unless asked.",
	"Engage with what the founder actually said, within the bounds of your role: push on weak points, and ask for the number or the named alternative when a claim is vague.",
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

// `kind: "command"` marks a slash-command invocation line or its output
// recorded into the session. It's still context for the next reply, but
// the intent classifier is told not to read it as a request (D-52
// amendment: momentum bias -- a thread that just ran /attack was pulling
// the next question toward another /attack).
function addTurn(session, { role, text, userId, ts, kind = null }) {
	// Tag the turn with the mode it was spoken in. A chat's mode changes
	// over its life, so "which turns belong to brainstorm" cannot be
	// recovered later from the chat's CURRENT mode -- it has to be recorded
	// at the time. doc-sync.js relies on this to keep a document syncing
	// only from its own stage's conversation.
	const spokenIn = session.kind === "project" && session.ideaId ? sessionMode(session) : null;
	session.turns.push({ role, text, userId: userId || null, ts: ts || null, ...(kind ? { kind } : {}), ...(spokenIn ? { mode: spokenIn } : {}) });
	persist(session);

	// Change 4: compress every N turns, across every mode, into
	// audit-reference.md -- the only place besides research reports the
	// audit tool is allowed to read. Fire-and-forget: a compression
	// failure must never block the turn that triggered it (a founder
	// mid-conversation shouldn't stall on it), and it's caught/logged
	// inside maybeCompress itself.
	if (session.kind === "project" && session.ideaId) {
		const { maybeCompress } = require("./audit-reference");
		// Was `readState(id).mode`, which broke silently when mode moved to
		// per-chat: state.mode became undefined, the fallback fired, and
		// EVERY entry was labelled "brainstorm" regardless of the chat's
		// actual mode. D-54 requires the entry to say which mode produced it
		// ("the auditor must be able to tell them apart"), so the record was
		// wrong for every non-brainstorm chat.
		const mode = sessionMode(session);
		// Deck mode is a branch, not a step: its conversation is persuasion
		// (how the idea gets framed for an audience), and feeding that to the
		// gate is close to the laundering the compressor exists to prevent.
		// The exclusion is symmetric with deck not reading the audit report.
		if (mode !== "deck") {
			maybeCompress(session.ideaId, mode, session.turns).catch((e) =>
				console.error(`addTurn: compression trigger failed for ${session.ideaId}: ${e.message}`),
			);
		}
	}

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
// Assets deck mode must NEVER see. Named explicitly rather than left to
// "nothing happens to load them": the audit report is the auditor's
// working record -- raw founder beliefs, contradiction flags, kill
// reasoning -- and a deck is the artifact most likely to be shown to
// outsiders. Keeping the two apart is the point of deck being a branch.
const DECK_FORBIDDEN = ["audit-reference.md", /^audit-\d{8}-\d{4}\.json$/];

function isForbiddenForDeck(filename) {
	return DECK_FORBIDDEN.some((rule) => (typeof rule === "string" ? rule === filename : rule.test(filename)));
}

// Everything the project knows, minus DECK_FORBIDDEN. Each asset is its
// own system message so the cached prefix stays stable as individual
// documents change.
function buildDeckAssets(ideaId) {
	const fs = require("node:fs");
	const path = require("node:path");
	const { IDEAS_DIR } = require("./ideas");
	const dir = path.join(IDEAS_DIR, ideaId);
	const out = [];

	const add = (filename, label, cap = 24000) => {
		if (isForbiddenForDeck(filename)) return; // belt and braces
		const p = path.join(dir, filename);
		if (!fs.existsSync(p)) return;
		const body = fs.readFileSync(p, "utf8");
		out.push({ role: "system", content: `${label} (${filename}):\n\n${body.slice(0, cap)}` });
	};

	add("research-kb.md", "Research knowledge base");
	add("product-spec.md", "Product spec");
	add("engineering-spec.md", "Engineering spec");
	add("outcomes.md", "Prototype outcomes — what real people did when shown the built thing");
	add(path.join("find", "index.md"), "Surface-search reports (NOT evidence — unverified web lookups)");
	add(path.join("docs", "index.md"), "Uploaded documents (index)");

	// Latest research report + raw field notes: the strongest material a
	// deck can legitimately draw on, and the only sourced claims available.
	try {
		const reports = fs.readdirSync(dir).filter((f) => /^research-\d{8}-\d{4}\.md$/.test(f)).sort();
		if (reports.length) add(reports[reports.length - 1], "Latest research report (sourced evidence)");
	} catch { /* no reports */ }
	try {
		const fieldDir = path.join(dir, "field");
		for (const f of fs.readdirSync(fieldDir).filter((f) => f.endsWith(".md")).sort().slice(-3)) {
			const body = fs.readFileSync(path.join(fieldDir, f), "utf8");
			out.push({ role: "system", content: `Raw field notes (${f}) — what real people actually said:\n\n${body.slice(0, 8000)}` });
		}
	} catch { /* no field notes */ }

	return out;
}

// The mode a session is in. A #chats session is a project-less BRAINSTORM
// chat -- same concept, same persona, just no documents to feed from
// (there is no project). A project chat carries its own mode, per chat.
function sessionMode(session) {
	if (session?.kind === "project" && session.ideaId) {
		try {
			return require("./chats").chatMode(session.ideaId, session.threadTs);
		} catch {
			return "brainstorm";
		}
	}
	return "brainstorm";
}

// `trailingSystem` is a system message placed AFTER all stable context but
// IMMEDIATELY BEFORE the live turns. The agent loop uses it for the mode's
// persona: placed at the head instead, the role instruction sat behind the
// generic tool prompt, the documents, the origin chat and the topic, and
// the model reliably ignored its refusals -- an engineer let a founder
// renegotiate product scope that its own product spec put out of scope.
// Nearest the conversation is where a role instruction has to be.
function buildContextMessages(session, { trailingSystem = null } = {}) {
	const messages = [{ role: "system", content: CONTEXT_SYSTEM_PROMPT }];
	const mode = sessionMode(session);

	// The founder's profile and their recent captures are "how this founder
	// thinks and fails" -- that is ammunition for the co-founder attacking
	// from their blind spot (D-26), which is a brainstorm job. The PM,
	// engineer and builder judge a spec on its own merits; feeding them
	// "this founder overrates distribution" would let the profile shape
	// durable artifacts rather than critique. The auditor never sees either
	// (D-28) and never reaches this path at all.
	if (mode === "brainstorm") {
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
	}

	// DECK MODE reads every asset EXCEPT the audit report. It is a branch,
	// not a link in the chain, so the feeding rule below does not apply --
	// a deck wants everything the project knows.
	//
	// The exclusion is a deny-list on purpose. Leaving the audit report out
	// "because nothing happens to load it" would be an accident one future
	// change could undo silently; naming it makes removing it a deliberate
	// act someone has to argue for.
	if (session.kind === "project" && session.ideaId && mode === "deck") {
		try {
			messages.push(...buildDeckAssets(session.ideaId));
		} catch (err) {
			console.error(`buildContextMessages: deck assets unavailable: ${err.message}`);
		}
	} else if (session.kind === "project" && session.ideaId && mode !== "audit") {
		// The feeding rule (Change 2) in CONVERSATION, not just in document
		// generation. A persona was previously document-blind while chatting:
		// an engineering-mode chat had no product spec and no engineering spec
		// in context, so the engineer answered "I can't do this without stated
		// failure modes" about a design whose failure modes were in its own
		// spec. Same rule as runPersonaTurn: the previous stage's document
		// plus this mode's own current document, nothing further upstream.
		try {
			const { readInputDoc, readDoc } = require("./mode-docs");
			const { personaFor } = require("./personas");
			const persona = personaFor(mode);
			const input = readInputDoc(session.ideaId, mode);
			if (input) {
				messages.push({ role: "system", content: `${persona.inputDoc} (your input document — the feeding rule gives you this and nothing further upstream):\n\n${input}` });
			} else if (persona.inputDoc) {
				messages.push({ role: "system", content: `Your input document (${persona.inputDoc}) does not exist yet.` });
			}
			const own = persona.outputDoc ? readDoc(session.ideaId, mode) : null;
			if (own) {
				messages.push({ role: "system", content: `${persona.outputDoc} (the document THIS mode owns, as it currently stands):\n\n${own}` });
			}
		} catch (err) {
			console.error(`buildContextMessages: mode documents unavailable: ${err.message}`);
		}
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

	if (trailingSystem) messages.push({ role: "system", content: trailingSystem });

	// Verbatim turns not yet folded into the summary. Command lines and
	// their output stay in context for the reply, but are marked so the
	// intent classifier doesn't read them as a fresh request (D-52
	// amendment: a thread that just ran /attack was biasing the next
	// question toward another /attack).
	for (const turn of session.turns.slice(session.compactedThrough)) {
		const content =
			turn.kind === "command" && turn.role === "assistant"
				? `[output of a slash-command run earlier in this thread — reference only, not a request]\n\n${turn.text}`
				: turn.text;
		messages.push({ role: turn.role, content });
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
		const t0 = Date.now();
		const { content, usage, costUsd, cacheHit } = await callFlash(messages, { model: "flash-fast", maxTokens: 2048 });
		summaryText = (content || "").trim();
		// This LLM call was previously uninstrumented -- it's spent but
		// never logged, which shows up in C-23 (telemetry under-reports a
		// window that includes a compaction).
		emit(
			buildEvalEvent({
				stage: "compaction",
				model: "flash-fast",
				founder: session.ownerFounder,
				ideaId: session.ideaId || null,
				tokensIn: usage?.prompt_tokens ?? 0,
				tokensOut: usage?.completion_tokens ?? 0,
				costUsd,
				cacheHitRatio: cacheHit ? 1 : 0,
				wallClockS: (Date.now() - t0) / 1000,
				status: "ok",
				reasonCode: `folded_to_${foldEnd}`,
			}),
		);
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
		// Project chats used to be skipped here (they are marked promoted),
		// which meant a founder who did their thinking inside projects
		// produced no captures at all -- so /themes saw nothing and the
		// weekly profile diff (D-30) read an empty week. Captures are the
		// raw substrate D-26/D-42 assume; project chats are where the raw
		// thinking now happens, so they belong in it.
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

	// Project channel (Change 1, docs/build-prompt-modes.md): every
	// command posts into the single project thread, keyed on thread_ts --
	// D-47's five stage threads are gone. If that thread_ts is missing/
	// stale the caller (postCommandResult / ensureStageThread) reposts the
	// anchor rather than ever posting to channel root.
	const project = command.channel_id ? findIdeaByChannel(command.channel_id) : null;
	if (project) {
		// A project holds many chats. Prefer the chat this command was
		// invoked from; otherwise the last active one.
		const chats = require("./chats");
		const invoked = command.thread_ts && chats.readChat(project.id, command.thread_ts) ? command.thread_ts : null;
		return {
			channel: command.channel_id,
			threadTs: invoked || chats.lastActiveChatTs(project.id) || project.threads?.project,
			session: null,
			inChat: false,
			project,
			stage: "project",
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
	if (!dest.project) return dest.threadTs;
	if (dest.threadTs) return dest.threadTs;
	// A project with no chat yet: open one, so a command never posts to
	// channel root. Its card is the new chat's thread root (chat-card.js).
	try {
		const { createChatCard } = require("./chat-card");
		const { chatTs } = await createChatCard(client, dest.project.id, {
			title: dest.project.assumption ? "Main" : "Main",
			createdBy: dest.project.founder || null,
		});
		dest.threadTs = chatTs;
		dest.project.threads = { ...(dest.project.threads || {}), project: chatTs };
	} catch (err) {
		console.error(`ensureStageThread: could not open a chat for ${dest.project.id}: ${err.message}`);
	}
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
	// (No promote button here -- it lives on the chat's card, not on every
	// command result posted into the thread.)
	// Bug 1: land in the "On it — running /x…" placeholder when there is
	// one (reply.js). Falls back to a plain post otherwise.
	const posted = await postResult(client, msg);
	if (dest.session) {
		if (invocation) addTurn(dest.session, { role: "user", text: invocation, userId: userId || null, kind: "command" });
		addTurn(dest.session, { role: "assistant", text, kind: "command" });
	}
	return posted;
}

module.exports = {
	sessionMode,
	buildDeckAssets,
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
