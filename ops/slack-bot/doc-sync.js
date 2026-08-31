"use strict";

// Keeping a stage's document current with the conversation that produced
// it — automatically, incrementally, and without losing what's there.
//
// WHY AUTOMATIC. The earlier design made saving explicit (`@Mill save`),
// reasoning from D-30 that a document downstream modes feed on shouldn't
// be rewritten without a human in the loop. In practice that meant a
// founder could talk for an hour, switch mode, and carry none of it
// forward — the document silently went stale while the card still showed
// it as present. The founders' call is that these are machine-maintained
// artifacts, not founder prose, so keeping them in sync is bookkeeping
// rather than an edit needing approval. Recorded as a deliberate
// reversal, not drift: the mitigations are that a sync is incremental
// (only turns since the watermark), reconciled rather than regenerated
// (the model sees the current document and decides append vs revise per
// section), and always reported with a word delta.
//
// THE WATERMARK. `chat.synced_through[mode]` is an index into that chat's
// turns — how far the conversation has been folded into that mode's
// document. Everything after it is what a sync considers. This is what
// makes ping-ponging between stages safe: going back to brainstorm after
// a detour syncs only the new brainstorm turns, not the whole thread
// again.
//
// SCOPE (founders' call). A document syncs ONLY from turns spoken in its
// own stage — `turn.mode`, recorded at the time by chat-session's addTurn,
// because a chat's current mode says nothing about which mode a turn was
// spoken in. So an engineering tangent cannot rewrite the research base.
// A research-relevant remark made in engineering mode still reaches
// audit-reference.md; it just doesn't reach the KB.

const { readDoc, writeDoc, runPersonaTurn } = require("./mode-docs");
const { personaFor } = require("./personas");
const { attachFullDocument, summarizeForThread } = require("./mode-docs");
const chats = require("./chats");

const wordCount = (t) => String(t || "").split(/\s+/).filter(Boolean).length;

// Turns in this chat, spoken in `mode`, not yet folded into that mode's
// document. The watermark advances past turns of other modes too — they
// are not this document's business and re-examining them later would only
// risk pulling an engineering aside into a research base.
function unsyncedTurns(session, chat, mode) {
	const from = chat?.synced_through?.[mode] ?? 0;
	return {
		from,
		to: session.turns.length,
		turns: session.turns
			.slice(from)
			.filter((t) => t.mode === mode && t.text?.trim() && t.kind !== "command"),
	};
}

function formatTurns(turns) {
	return turns.map((t) => `${t.role === "user" ? "Founder" : "Mill"}: ${t.text.trim()}`).join("\n");
}

// The reconcile instruction. Deliberately framed as a per-section
// decision rather than "rewrite the document": the failure mode being
// designed against is a model quietly dropping a fact it wasn't asked to
// remove, which is what happens when you hand it a blank-page rewrite.
function reconcileDirective(persona, existing, newTurnsText) {
	return [
		`Below is the CURRENT ${persona.outputTitle}, then the conversation since it was last updated.`,
		"",
		`--- CURRENT ${persona.outputTitle} ---`,
		existing,
		"--- end ---",
		"",
		"--- NEW CONVERSATION SINCE ---",
		newTurnsText,
		"--- end ---",
		"",
		`Produce the updated ${persona.outputTitle}. Go section by section and decide for each:`,
		"  • UNCHANGED — the conversation didn't touch it. Reproduce it verbatim.",
		"  • APPEND — the conversation added something. Keep what's there and add.",
		"  • REVISE — the conversation contradicted or superseded it. Rewrite that section, and say so",
		"    in one line at the end under a `## Changed in this update` heading.",
		"",
		"This REPLACES the file, so anything still true must appear in your output. Dropping a fact you were",
		"not asked to remove is the failure to avoid — specifics especially: numbers, named competitors, named",
		"regulations, prices, dates. If the new conversation adds nothing to this document, output the current",
		"document unchanged.",
	].join("\n");
}

// Reconciles one mode's document with the unsynced conversation in one
// chat. Returns { ok, skipped?, created?, before, after, shrankBy }.
async function syncModeDocument({ id, mode, chatTs, client, channel, threadTs, announce = true }) {
	const persona = personaFor(mode);
	if (!persona.outputDoc) return { ok: true, skipped: "mode produces no document" };

	const { getSession } = require("./chat-session");
	const session = getSession(chatTs);
	const chat = chats.readChat(id, chatTs);
	if (!session || !chat) return { ok: true, skipped: "no session" };

	const { to, turns } = unsyncedTurns(session, chat, mode);
	if (!turns.length) {
		// Still advance the watermark: there was nothing of this mode's to
		// fold in, and leaving it behind would re-scan the same turns.
		chats.updateChat(id, chatTs, { synced_through: { ...(chat.synced_through || {}), [mode]: to } });
		return { ok: true, skipped: "nothing new in this stage's conversation" };
	}

	const existing = readDoc(id, mode);
	const before = wordCount(existing);
	const directive = existing
		? reconcileDirective(persona, existing, formatTurns(turns))
		: `Write the ${persona.outputTitle} from the conversation below, as a complete document.\n\n${formatTurns(turns)}`;

	const result = await runPersonaTurn({ id, mode, threadContext: "", userText: directive, maxTokens: 8000 });
	if (result.refusal) return { ok: false, reason: "refused", refusal: result.refusal };

	const after = wordCount(result.text);
	const shrankBy = before ? Math.round(((before - after) / before) * 100) : 0;
	const materialShrink = before > 200 && shrankBy >= 40;

	writeDoc(id, mode, result.text);
	chats.updateChat(id, chatTs, { synced_through: { ...(chat.synced_through || {}), [mode]: to } });

	if (announce && client && channel) {
		const verb = existing ? "Updated" : "Created";
		const delta = existing ? ` · ${before} → ${after} words` : ` · ${after} words`;
		const warn = materialShrink
			? `\n\n⚠️ *This shrank the document by ${shrankBy}%.* Check nothing was dropped — the previous version is in git history.`
			: "";
		const summary = await summarizeForThread(result.text).catch(() => result.text.slice(0, 400));
		await client.chat
			.postMessage({ channel, thread_ts: threadTs, text: `💾 ${verb} *${persona.outputTitle}* from this chat${delta}:\n\n${summary}${warn}` })
			.catch(() => {});
		await attachFullDocument(client, { id, mode, channel, threadTs });
	}

	return { ok: true, created: !existing, before, after, shrankBy, materialShrink, turnsFolded: turns.length };
}

// Called on the first message after a mode switch: bring the mode the
// chat just LEFT up to date, so the document carries the context forward
// rather than the new mode dragging the old thread's turns along.
async function syncPreviousMode({ id, chatTs, client, channel, threadTs }) {
	const chat = chats.readChat(id, chatTs);
	const prev = chat?.prev_mode;
	if (!prev) return { ok: true, skipped: "no previous mode" };
	const res = await syncModeDocument({ id, mode: prev, chatTs, client, channel, threadTs });
	// Clear the marker either way: a failed sync must not retry on every
	// subsequent message, which would spend a model call per turn.
	chats.updateChat(id, chatTs, { prev_mode: null });
	return { ...res, mode: prev };
}

module.exports = { syncModeDocument, syncPreviousMode, unsyncedTurns };
