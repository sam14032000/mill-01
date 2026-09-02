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
const { personaFor, PARTIAL_ACCEPTANCE } = require("./personas");
const { attachFullDocument, summarizeForThread } = require("./mode-docs");
const chats = require("./chats");

const wordCount = (t) => String(t || "").split(/\s+/).filter(Boolean).length;

// Turns in this chat, spoken in `mode`, not yet folded into that mode's
// document. The watermark advances past turns of other modes too — they
// are not this document's business and re-examining them later would only
// risk pulling an engineering aside into a research base.
// Turns recorded BEFORE mode-tagging existed carry no `mode`. Treating
// them as belonging to no stage silently excluded them from every sync --
// f05e's 46-turn brainstorm was filtered to nothing and never reached the
// research KB. Every chat starts in brainstorm (it is the mandatory entry
// mode), and any chat old enough to hold untagged turns began there, so an
// untagged turn is attributed to brainstorm rather than dropped.
function turnMode(t) {
	return t.mode || "brainstorm";
}

function unsyncedTurns(session, chat, mode) {
	const from = chat?.synced_through?.[mode] ?? 0;
	return {
		from,
		to: session.turns.length,
		turns: session.turns
			.slice(from)
			.filter((t) => turnMode(t) === mode && t.text?.trim() && t.kind !== "command"),
	};
}

function formatTurns(turns) {
	return turns.map((t) => `${t.role === "user" ? "Founder" : "Mill"}: ${t.text.trim()}`).join("\n");
}


// PARTIAL ACCEPTANCE (founders' call).
//
// A persona refusal used to be all-or-nothing: the PM objected to one
// under-specified feature in a founder's message and the entire document
// write was abandoned, losing the parts that were properly specified. The
// founders chose the middle option -- write what passes, refuse the rest
// by name, in one message.
//
// A trailer rather than a JSON envelope, for the same reason D-51 chose
// one: escaping a markdown document into a JSON string field is a
// reliability problem, and the document is the payload here.
const NOT_INCORPORATED = "---NOT-INCORPORATED---";

const { askClause, parseNeedsInput } = require("./doc-questions");

// Personas whose bar governs document CONTENT ask/refuse per item. Not
// brainstorm: research-kb.md records what was discussed so downstream
// modes have context and the audit chain sees the founder's actual
// beliefs, and filtering it defeats that.
const partialClause = (persona) => (PARTIAL_ACCEPTANCE.has(persona.mode) ? askClause(persona) : "");

// Splits the model's output into the document and the excluded-items
// report. The document written to disk never contains the trailer.
function splitNotIncorporated(text) {
	const i = String(text).indexOf(NOT_INCORPORATED);
	let doc = i === -1 ? String(text).trim() : String(text).slice(0, i).trim();
	let excluded = i === -1 ? null : String(text).slice(i + NOT_INCORPORATED.length).trim() || null;

	// Salvage: a refusal written INSIDE the document rather than below the
	// trailer. Observed -- the PM correctly refused a Postgres schema in a
	// product spec and then wrote "REFUSAL: ..." as the closing line of the
	// spec itself, so the file gained a refusal and the founder was told
	// nothing was excluded. A document must never contain a bare REFUSAL:
	// line, whatever the model does with the delimiter, so they are lifted
	// out here rather than trusted to the prompt.
	const lines = doc.split("\n");
	const strays = [];
	while (lines.length) {
		const last = lines[lines.length - 1].trim();
		if (!last) { lines.pop(); continue; }
		if (/^(REFUSAL|UNBLOCK):/i.test(last)) { strays.unshift(lines.pop().trim()); continue; }
		break;
	}
	if (strays.length) {
		doc = lines.join("\n").trim();
		excluded = [excluded, strays.join("\n")].filter(Boolean).join("\n");
	}
	return { doc, excluded };
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
		partialClause(persona),
	].join("\n");
}

// Reconciles one mode's document with the unsynced conversation in one
// chat. Returns { ok, skipped?, created?, before, after, shrankBy }.
async function syncModeDocument({ id, mode, chatTs, client, channel, threadTs, announce = true, docqRound = 1 }) {
	const persona = personaFor(mode);
	if (!persona.outputDoc) return { ok: true, skipped: "mode produces no document" };

	const { getSession } = require("./chat-session");
	const session = getSession(chatTs);
	const chat = chats.readChat(id, chatTs);
	if (!session || !chat) return { ok: true, skipped: "no session" };

	const { to, turns } = unsyncedTurns(session, chat, mode);
	if (!turns.length) {
		// Do NOT advance the watermark here.
		//
		// It used to, to avoid re-scanning. That made a no-op sync
		// destructive: when tagging changed what counted as a brainstorm
		// turn, a sync matched nothing, moved the watermark past 47 real
		// turns, and permanently marked a conversation as folded in that
		// never was. Re-scanning is an in-memory filter; losing a
		// conversation is forever. The asymmetry decides it.
		return { ok: true, skipped: "nothing new in this stage's conversation" };
	}

	const existing = readDoc(id, mode);
	const before = wordCount(existing);
	const directive = existing
		? reconcileDirective(persona, existing, formatTurns(turns))
		: `Write the ${persona.outputTitle} from the conversation below, as a complete document.${partialClause(persona)}\n\n${formatTurns(turns)}`;

	const result = await runPersonaTurn({ id, mode, threadContext: "", userText: directive, maxTokens: 8000 });
	if (result.refusal) return { ok: false, reason: "refused", refusal: result.refusal };

	// Two trailers, two meanings: questions the founder can answer, and
	// refusals no answer would change.
	const parsedQ = parseNeedsInput(result.text);
	const { doc: docText, excluded } = splitNotIncorporated(parsedQ.rest);
	const { MAX_ROUNDS, askAll } = require("./doc-questions");
	// Past the round cap the questions stop and become plain exclusions,
	// so an answer the persona keeps finding inadequate can't loop.
	const questions = docqRound <= MAX_ROUNDS ? parsedQ.items : [];
	const cappedOut = docqRound > MAX_ROUNDS && parsedQ.items.length
		? parsedQ.items.map((it) => `REFUSAL: ${it.item} — still ${it.question}\nUNBLOCK: say it in the thread and ask me to save again.`).join("\n")
		: null;
	const after = wordCount(docText);
	const shrankBy = before ? Math.round(((before - after) / before) * 100) : 0;
	const materialShrink = before > 200 && shrankBy >= 40;

	writeDoc(id, mode, docText);
	chats.updateChat(id, chatTs, { synced_through: { ...(chat.synced_through || {}), [mode]: to } });

	if (announce && client && channel) {
		const verb = existing ? "Updated" : "Created";
		const delta = existing ? ` · ${before} → ${after} words` : ` · ${after} words`;
		const warn = materialShrink
			? `\n\n⚠️ *This shrank the document by ${shrankBy}%.* Check nothing was dropped — the previous version is in git history.`
			: "";
		const summary = await summarizeForThread(docText).catch(() => docText.slice(0, 400));
		// One message: what went in, and what did not and why. Splitting
		// these across two posts is how a founder reads the first and
		// misses the second.
		const allExcluded = [excluded, cappedOut].filter(Boolean).join("\n");
		const left = allExcluded ? `\n\n*Not incorporated:*\n${allExcluded}` : "";
		const asking = questions.length
			? `\n\n_${questions.length} thing${questions.length === 1 ? "" : "s"} still to settle — see the question${questions.length === 1 ? "" : "s"} below._`
			: "";
		// Surface the next action at the moment it becomes possible, rather
		// than only in the error you get for not knowing it existed.
		const next = persona.actionHint ? `\n\n_${persona.actionHint}_` : "";
		await client.chat
			.postMessage({ channel, thread_ts: threadTs, text: `💾 ${verb} *${persona.outputTitle}* from this chat${delta}:\n\n${summary}${left}${asking}${warn}${next}` })
			.catch(() => {});
		await attachFullDocument(client, { id, mode, channel, threadTs });
		if (questions.length) {
			await askAll({ id, chatTs, mode, items: questions, client, channel, round: docqRound });
		}
	}

	return {
		ok: true, created: !existing, before, after, shrankBy, materialShrink,
		turnsFolded: turns.length, excluded: [excluded, cappedOut].filter(Boolean).join("\n") || null,
		questions: questions.length,
	};
}

// maybeSyncCurrentMode (fold the current mode up every N turns) lived
// here and is REMOVED. It fired mid-work on a turn counter, so a document
// changed with no founder action to attribute it to. `save` is now a tool
// the agent calls when asked, which covers that case properly.
//
// syncPreviousMode below is DELIBERATELY KEPT. It is not the same thing:
// it fires at a boundary the founder just created by switching stages,
// and forgetting to save before a switch is silent and deferred -- the
// next persona reads a stale upstream document and answers confidently
// from it. "Ask for a save" is not a substitute for that, because a
// founder will not reliably remember.

// Called on the first message after a mode switch: bring the mode the
// chat just LEFT up to date, so the document carries the context forward
// rather than the new mode dragging the old thread's turns along.
//
// On the FIRST MESSAGE rather than at switch time, so a founder stepping
// through modes to decide where to start doesn't fire a sync per switch.
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

module.exports = { syncModeDocument, syncPreviousMode, unsyncedTurns, splitNotIncorporated, NOT_INCORPORATED };
