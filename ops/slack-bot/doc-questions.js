"use strict";

// Asking for the missing information instead of refusing over it.
//
// The personas are defined by refusal (D-54), and per-item acceptance
// (D-55 amendment) stopped one bad item from sinking a whole document
// write. But a refusal is still a dead end the founder has to resolve by
// composing prose: "name the user, state the job, give me a metric". Most
// of the time the persona can see perfectly well what the plausible
// answers are -- it has the research KB, the spec and the conversation.
// Making the founder type out what the model could have proposed is work
// the machine should be doing.
//
// So an item that fails the bar FOR WANT OF INFORMATION becomes a
// question with the answers already filled in: two or three concrete
// recommendations, a custom entry, and a skip that takes the top
// recommendation. One tap on a phone.
//
// This does NOT replace refusal. Two kinds of exclusion exist and they
// are not alike:
//   - missing information  -> ask (this module)
//   - outside this role     -> refuse (the PM will not put a database
//     schema in a product spec no matter how the founder answers)
// The persona decides which it is, and the trailer it emits says so.
//
// The skip default is deliberate and is the reason this is not just a
// form. A founder who taps skip has not said "leave it out" -- they have
// said "you choose". Taking the top recommendation keeps the document
// moving while leaving an explicit record in the thread of what was
// assumed on their behalf.

const chats = require("./chats");

const NEEDS_INPUT = "---NEEDS-INPUT---";

// How many times one save may come back asking. Without a cap, an answer
// the persona still finds inadequate produces the same question forever.
const MAX_ROUNDS = Number(process.env.MILL_DOCQ_MAX_ROUNDS) || 2;

// The clause appended to a write directive for personas whose bar is
// about document content. Kept as prose the model can follow rather than
// a schema it must conform to -- the document is the payload, and a
// delimiter is more reliable than escaping markdown into JSON (D-51).
function askClause(persona) {
	return [
		"",
		"THIS ROLE'S BAR APPLIES PER ITEM, NOT TO THE WHOLE REQUEST.",
		"Incorporate everything the founder described that meets your bar. Never refuse the whole",
		`${persona.outputTitle} because part of what was asked falls short.`,
		"",
		"For anything that falls short, decide WHICH KIND it is:",
		"",
		"(a) It is missing information you could plausibly propose from the research base, the current",
		"    document and this conversation -- an unnamed user, an absent metric, an unstated job, a",
		"    missing failure mode or cost. Do NOT refuse these and do NOT write a weakened placeholder.",
		`    Leave the item out of the ${persona.outputTitle} for now and ask for it, using this exact form`,
		"    after the document:",
		NEEDS_INPUT,
		"    ITEM: <the thing being added, in a few words>",
		"    QUESTION: <one direct question that would unblock it>",
		"    OPTION: <short label, max 40 chars> | <the full answer, concrete and specific>",
		"    OPTION: <short label> | <full answer>",
		"    OPTION: <short label> | <full answer>",
		"",
		"    Give two or three options, BEST FIRST -- the first is what gets used if the founder skips.",
		"    They must be real proposals grounded in what this project already knows, not placeholders",
		"    like \"a metric to be defined\". Repeat the ITEM/QUESTION/OPTION group for each such item.",
		"",
		"(b) It is outside this role's remit and no answer from the founder would change that (for",
		"    example: implementation detail in a product spec). Leave it out and refuse it AFTER the",
		"    document, below this exact line on its own:",
		"    ---NOT-INCORPORATED---",
		"    then a `REFUSAL:` line naming the item and a `UNBLOCK:` line naming where it belongs.",
		"    The refusal must never appear inside the document itself -- everything above the trailers",
		`    IS the ${persona.outputTitle} and gets written to the file verbatim.`,
		"",
		"Emit neither trailer if everything was incorporated.",
	].join("\n");
}

// Pulls the question groups out of the model's output. Returns the text
// with the trailer removed, plus the parsed items.
function parseNeedsInput(text) {
	const i = String(text).indexOf(NEEDS_INPUT);
	if (i === -1) return { rest: String(text), items: [] };
	const rest = String(text).slice(0, i);
	const body = String(text).slice(i + NEEDS_INPUT.length);
	const items = [];
	let cur = null;
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		const item = line.match(/^ITEM:\s*(.+)$/i);
		const q = line.match(/^QUESTION:\s*(.+)$/i);
		const o = line.match(/^OPTION:\s*(.+)$/i);
		if (item) {
			if (cur?.question && cur.options.length) items.push(cur);
			cur = { item: item[1].trim(), question: "", options: [] };
		} else if (q && cur) {
			cur.question = q[1].trim();
		} else if (o && cur) {
			const [label, ...restParts] = o[1].split("|");
			const full = restParts.join("|").trim();
			cur.options.push({
				label: (label || "").trim().slice(0, 70) || full.slice(0, 70),
				answer: full || (label || "").trim(),
			});
		}
	}
	if (cur?.question && cur.options.length) items.push(cur);
	return { rest, items };
}

// --- pending state, on the chat record so it survives a restart --------

function setPending(id, chatTs, pending) {
	chats.updateChat(id, chatTs, { pending_docq: pending });
}
function getPending(id, chatTs) {
	return chats.readChat(id, chatTs)?.pending_docq || null;
}
function clearPending(id, chatTs) {
	chats.updateChat(id, chatTs, { pending_docq: null });
}

// --- Slack rendering ---------------------------------------------------

// One question per message: `resolveMessage` strips every actions block
// from the message it resolves, so two questions in one message would
// both go dead on the first tap.
function questionBlocks({ id, chatTs, index, item }) {
	const listed = item.options
		.map((o, i) => `${i === 0 ? "*→*" : "  •"} *${o.label}*${i === 0 ? "  _(used if you skip)_" : ""}\n     ${o.answer}`)
		.join("\n");
	const text = `*${item.item}* — I need one thing before this goes in.\n\n${item.question}\n\n${listed}`;
	const v = (extra) => `${id}::${chatTs}::${index}${extra}`;
	const elements = item.options.slice(0, 3).map((o, i) => ({
		type: "button",
		// Unique WITHIN the block -- Slack rejects the message otherwise,
		// and only a real API call catches it (D-54).
		action_id: `docq_pick_${i}`,
		...(i === 0 ? { style: "primary" } : {}),
		text: { type: "plain_text", text: o.label.slice(0, 75) },
		value: v(`::${i}`),
	}));
	elements.push({ type: "button", action_id: "docq_custom", text: { type: "plain_text", text: "Something else…" }, value: v("") });
	elements.push({ type: "button", action_id: "docq_skip", text: { type: "plain_text", text: "Skip" }, value: v("") });
	return {
		text: `${item.item} — ${item.question}`,
		blocks: [
			{ type: "section", text: { type: "mrkdwn", text } },
			{ type: "actions", block_id: `docq_${index}`, elements },
		],
	};
}

function customModal({ id, chatTs, index, item }) {
	return {
		type: "modal",
		callback_id: "docq_custom_modal",
		private_metadata: `${id}::${chatTs}::${index}`,
		title: { type: "plain_text", text: "Your answer" },
		submit: { type: "plain_text", text: "Use this" },
		close: { type: "plain_text", text: "Cancel" },
		blocks: [
			{ type: "section", text: { type: "mrkdwn", text: `*${item.item}*\n${item.question}` } },
			{
				type: "input",
				block_id: "docq_answer",
				label: { type: "plain_text", text: "Answer" },
				element: { type: "plain_text_input", action_id: "value", multiline: true },
			},
		],
	};
}

// --- posting and answering ---------------------------------------------

// Posts one message per outstanding question and records them as pending.
async function askAll({ id, chatTs, mode, items, client, channel, round = 1, source = "save", chain = 0 }) {
	const pending = { mode, round, source, chain, items: items.map((it) => ({ ...it, answer: null, skipped: false })) };
	setPending(id, chatTs, pending);
	for (let i = 0; i < pending.items.length; i += 1) {
		const { text, blocks } = questionBlocks({ id, chatTs, index: i, item: pending.items[i] });
		await client.chat.postMessage({ channel, thread_ts: chatTs, text, blocks }).catch((e) => {
			console.error(`doc-questions: could not post question ${i} for ${id}: ${e?.data?.error || e.message}`);
		});
	}
	return pending;
}

function recordAnswer(id, chatTs, index, answer, { skipped = false } = {}) {
	const pending = getPending(id, chatTs);
	if (!pending || !pending.items[index]) return null;
	pending.items[index] = { ...pending.items[index], answer, skipped };
	setPending(id, chatTs, pending);
	return pending;
}

const outstanding = (pending) => (pending?.items || []).filter((it) => !it.answer).length;

// Every question answered -> fold the answers back into the conversation
// as a founder turn, then continue whatever was blocked on them. The
// answers become part of the thread rather than hidden state, so the next
// save (and audit-reference) sees them the way it sees anything else the
// founder said.
//
// What "continue" means depends on who asked:
//   source "save"  -> re-run the document write
//   source "agent" -> take another conversational turn, exactly as if the
//                     founder had typed the answer, so the agent can act
//                     on what it was missing
async function completeIfDone({ id, chatTs, client, channel, userId = null }) {
	const pending = getPending(id, chatTs);
	if (!pending || outstanding(pending) > 0) return { done: false };

	const { getSession, addTurn } = require("./chat-session");
	const session = getSession(chatTs);
	const lines = pending.items.map(
		(it) => `${it.item ? `${it.item} — ` : ""}${it.question}\n${it.answer}${it.skipped ? "  (I skipped; you chose this for me)" : ""}`,
	);
	const answerText = lines.join("\n\n");
	clearPending(id, chatTs);

	if (pending.source === "agent") {
		if (!session) return { done: true, result: null };
		// The turn has to be added HERE. runTurn does not record the founder
		// message -- chat-turn.js does that before calling it -- and the
		// model reads the conversation from the session, not from `message`.
		// Without this the answer reached nothing: the agent took a turn
		// that could not see what it had just been told.
		addTurn(session, { role: "user", text: answerText, userId: userId || null });
		const agent = require("./agent");
		const res = await agent.runTurn({
			session,
			message: { channel, user: userId || session.ownerUserId, text: answerText, ts: String(Date.now() / 1000) },
			client,
			// Survives into the next ask, so a chain of questions with no
			// human sentence between them cannot run away.
			askChain: (pending.chain || 0) + 1,
		});
		return { done: true, result: res };
	}

	if (session) {
		addTurn(session, { role: "user", text: `Answering what the ${pending.mode} document needed:\n\n${answerText}` });
	}
	const { runSaveForThread } = require("./mode-docflow");
	const res = await runSaveForThread({
		id, mode: pending.mode, client, channel, threadTs: chatTs,
		// The cap travels with the re-run, so a persona that still isn't
		// satisfied cannot ask the same question indefinitely.
		docqRound: pending.round + 1,
	});
	return { done: true, result: res };
}

// How many questions the agent may ask in a row without a human sentence
// between them. An answered question produces another turn, which could
// ask again; this is what stops that becoming an interrogation.
const MAX_ASK_CHAIN = Number(process.env.MILL_ASK_CHAIN_MAX) || 3;

module.exports = {
	NEEDS_INPUT,
	MAX_ROUNDS,
	MAX_ASK_CHAIN,
	askClause,
	parseNeedsInput,
	questionBlocks,
	customModal,
	askAll,
	recordAnswer,
	completeIfDone,
	getPending,
	clearPending,
	outstanding,
};
