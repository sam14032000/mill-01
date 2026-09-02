"use strict";

// The one agent loop above the commands (replaces the regex + confidence
// + guard cascade that used to live in chat-turn.js -- D-51/D-52).
//
// A founder says something in a #chats thread or a project stage thread.
// This gets the tool set + the thread context and decides: run one
// command, or just reply. Gates stay inside the commands (research_stub,
// C-07, the touch cap, the named-assumption requirement, TOO_VAGUE),
// enforced regardless of caller -- the loop never re-implements one.
//
// Boundary: everything goes through `runTurn({ session, message,
// client })`, which reads and writes session state in the project's own
// JSON schema (chat-session.js's disk mirror). That is what makes the
// loop implementation swappable -- a maintained harness could take this
// function's place without touching the tools or the session format.
//
// Deliberate invocations (`@Mill <cmd>`, slash commands, buttons) do NOT
// come through here -- they go straight to command-shim's dispatchCommand.

const { callFlashTools } = require("./llm");
const { emit } = require("./telemetry");
const { buildEvalEvent } = require("./eval-event");
const { addTurn, buildContextMessages, maybeCompact, sessionMode } = require("./chat-session");
const { personaFor, parseRefusal } = require("./personas");
const { callFlash } = require("./llm");
const { readState, readAssumption, readLatestResearch } = require("./ideas");
const { toolSpecs, runTool } = require("./tools");
const { withDeadline, softDeadline, tracer, DeadlineError } = require("./deadline");

const MODEL = "flash-fast";
const MAX_STEPS = Number(process.env.MILL_AGENT_MAX_STEPS) || 3;

const SYSTEM_PROMPT = [
	// No identity line here: the persona (personas.js) owns who you are.
	// This block is tool mechanics only -- when it also said \"You are Mill,\n\t// a thinking partner\", it competed with the role and won.
	"TOOLS. You have tools that do specific jobs properly (attack, think, cross, blindspot, themes, find, test, audit, proto, spinoff).",
	"",
	"Your default is to REPLY IN PROSE. Call a tool when the founder's LATEST message contains an explicit instruction to run that job — an imperative like \"attack this\", \"look up X\", \"what would the others say\", \"prototype it\", \"run the research pass\", \"you need to research that\", \"dig into whether X\".",
	"The instruction counts even when it's EMBEDDED in a longer message: a paragraph of hypothesis that also says \"you need to research that\" or \"look this up\" IS a request — run the tool, and treat the rest of the message as the subject / what to work on.",
	"Do NOT call a tool when the latest message is:",
	"- a statement or a musing with no instruction in it (\"i keep coming back to whether the liability is ours\", \"the margins worry me\")",
	"- a hypothetical or third-person framing (\"someone should test this\", \"we could look into it eventually\")",
	"- any kind of question (\"didn't we…\", \"what about…\", \"is that defensible?\") — a question is recall or clarification, NOT a request, unless it explicitly asks you to run something (\"can you attack this?\")",
	"When there's no instruction, reply in prose even if the idea looks attackable or researchable.",
	"",
	"Do not run a tool ON YOUR OWN INITIATIVE just because its output is already in the thread. BUT if the founder explicitly asks you to run it — including a second time, or after pushing back on an earlier result (\"not enough\", \"go deeper\", \"research that properly\") — run it again. Re-running on an explicit request is correct; the founder decides, not you. A thread already full of research-flavoured discussion is not a reason to withhold a `find` the founder just asked for.",
	"Call at most one tool. The founder drives the next step; do not chain commands.",
	"When you call a tool, produce no prose — the tool posts the real output.",
	"Prose replies: short and concrete. Engage with what they said, push on the weak point, ask for the number or the named alternative when a claim is vague. No headings, no essays.",
	"",
	"WHEN YOU'RE BLOCKED. You have `ask` — it puts a question in the thread with two or three answers you have already drafted, plus a custom entry and a Skip that takes your first option. Use it when you genuinely cannot do the job properly without a specific decision or fact from the founder: an unnamed user, a missing metric, which of two directions they meant, an unstated constraint. Draft the options from what this project already knows — they must be real proposals a founder could accept as-is, never \"to be defined\".",
	"The clearest case: the instruction points at something you cannot resolve — \"the other side\", \"that one\", \"like we discussed\", a feature named with no indication who it is for — and guessing would send real work in the wrong direction. Ask rather than pick.",
	"Do NOT use `ask` to check in, to confirm something you could reasonably infer, or in place of doing the work. If you can proceed and say what you assumed, do that instead — it is cheaper for the founder than a question. Asking is for a genuine block, not for reassurance.",
	"If the founder asked you to WRITE OR UPDATE a document and the only gap is detail the document itself would pin down, call `save` instead — it asks per item as it writes. Reserve `ask` for when you cannot even tell what they meant.",
	"NEVER write a `REFUSAL:` for something that is merely MISSING INFORMATION. If your role's bar is unmet only because a user, a metric, a job, a failure mode or a cost has not been stated, that is a question, not a refusal: call `ask` (or `save`, which asks as it writes). A refusal in prose leaves the founder to compose the answer you could have drafted for them. Keep `REFUSAL:` for what is outside this role's remit, where no answer from the founder would change it.",
	"",
	"WEB FACTS. You have `find`.",
	"- `find` with mode:\"quick\": use it MID-ANSWER only when answering well needs one specific, checkable fact you don't have — a price, a market-size number, a named regulation or filing threshold, a date, or whether a specific named company or product actually exists. One or two queries. Fold the finding into your prose reply — do NOT post it as a separate block — and end the reply with the exact marker: _(quick web check — not verified, not evidence)_",
	"- Do NOT search because you feel unsure, want to double-check, or the founder is being abstract. \"I'm not certain\" is not a trigger. \"I need this number / rule / name to answer correctly, and my answer is wrong or vague without it\" is. Most turns need no search — if you'd be searching on more than about one turn in five, you're fact-checking uncertainty, which kills the brainstorm. Reason from what you know instead.",
	"- `find` with mode:\"broad\": when the founder tells you to look something up, dig in, or research a question — including embedded in a longer message (\"…you need to research that\", \"research the background on this\"). Give it a concrete `query` built from that message plus the thread. Writes a stored report and posts a rundown. Still not evidence — only `test` produces something an audit can rule on.",
].join("\n");

const INLINE_MARKER = "_(quick web check — not verified, not evidence)_";
const NOT_EVIDENCE_RE = /not evidence|not verified|quick web check|surface (web )?check/i;

// Deterministic backstop for an unambiguous imperative to research /
// look up / dig into "this/that/it". The agent under-fires on these in
// long, research-heavy threads (D-53 amendment 2: it reads a thread
// already full of research talk as "keep synthesising"). When one is
// present we run `find` broad without asking the model.
const NOUN = "(?:above|background|market|space|category|landscape|competitors?|players?|options?|topic|question|area|idea|hypothesis)";
const FORCE_BROAD_FIND_PATTERNS = [
	// "you/we need to / should / have to / must ... research/look up/dig into/search"
	new RegExp(`\\b(?:you|we)\\s+(?:need\\s+to|should|have\\s+to|must)\\s+(?:go\\s+)?(?:and\\s+)?(?:research|look\\s+(?:up|into)|dig\\s+into|search)\\b`, "i"),
	// clause-start "research/look into/dig into/search for/up this|that|it|the <noun>"
	new RegExp(`(?:^|[.!?]\\s+|\\n\\s*|\\bplease\\s+|\\bnow\\s+|\\bgo\\s+(?:and\\s+)?)(?:research|look\\s+(?:up|into)|dig\\s+into|search\\s+(?:for|up|into))\\s+(?:more\\s+(?:on|about)\\s+|deeper\\s+(?:on|into)\\s+|into\\s+)?(?:this|that|it|these|those|the\\s+${NOUN})\\b`, "i"),
	// phrasal split: "look this/that/it up"
	/\blook\s+(?:this|that|it|these|those)\s+up\b/i,
	// "research it properly/again/deeper" -- surface-search intent
	/\bresearch\s+(?:this|that|it)\s+(?:properly|again|deeper|more|further|harder)\b/i,
	// "run research on/to/about X" -- but NOT "run the research pass"
	// (that's /test intent; let the model route test vs find)
	/\brun\s+research\s+(?:on|to|about|into|for|around)\b/i,
];

function shouldForceBroadFind(text) {
	const t = String(text || "").trim();
	if (!FORCE_BROAD_FIND_PATTERNS.some((re) => re.test(t))) return false;
	// hypothetical / third-person ("we could research…", "someone should look into…") -- let the model decide
	if (/\b(?:someone|somebody|anyone|no one|nobody|one|they|he|she|we|you)\s+(?:could|might|would|ought to|may)\s+(?:research|look|dig|search)\b/i.test(t)) return false;
	// a bare question ("should we research that?")
	if (/^(?:so\s+|but\s+|ok(?:ay)?[,\s]+)*(?:should|could|would|can|do|does|did|is|are|was|were|why|how|what|when|which)\b/i.test(t) && /\?\s*$/.test(t)) return false;
	return true;
}

function parseArgs(tc) {
	try {
		const a = JSON.parse(tc.function?.arguments || "{}");
		return a && typeof a === "object" ? a : {};
	} catch {
		return {};
	}
}

// Wraps the turn so a "Thinking…" placeholder ALWAYS resolves.
//
// It didn't. A founder's message sat on "_Thinking…_" for half an hour
// with the process idle and nothing logged: flash-fast returned empty
// content and no tool calls (the same payload WITHOUT tools returned a
// full answer -- tools change the response, as they did for refusals),
// the loop retried to MAX_STEPS, then emitted `max_steps` telemetry and
// returned without touching the placeholder. Telemetry recorded the
// failure; the founder saw silence.
//
// So the invariant is enforced here rather than at each exit: whatever
// happens inside -- return, throw, or falling out of the loop -- the
// founder is told something. The failure is now loud in the thread, not
// only in a JSONL file nobody is watching mid-conversation.
// The whole turn is bounded. A turn that has not answered within
// TURN_DEADLINE_MS is a hang, not a slow turn: the longest legitimate
// path is the veto (~4s) plus MAX_STEPS model calls at the 120s llm.js
// ceiling, and a tool that posts its own output settles the placeholder
// itself long before this. Tools that legitimately wait on a HUMAN —
// `/test`'s 30-minute field-evidence prompt — post their own message and
// own the thread from that point, so they are not sitting on the
// placeholder when this fires.
const TURN_DEADLINE_MS = Number(process.env.MILL_TURN_DEADLINE_MS) || 300_000;
// Ceiling on any single Slack write in the turn path. Slack's own client
// is now bounded too (index.js clientOptions), so this is belt and
// braces on the one call whose failure is invisible to the founder.
const WRITE_DEADLINE_MS = Number(process.env.MILL_WRITE_DEADLINE_MS) || 20_000;

async function runTurn(args) {
	const { session, message, client } = args;
	const trace = tracer(session.threadTs);
	trace.step("placeholder");
	const placeholderTs = await softDeadline(
		client.chat
			.postMessage({ channel: message.channel, thread_ts: session.threadTs, text: "_Thinking…_" })
			.then((r) => r.ts),
		WRITE_DEADLINE_MS,
		"placeholder post",
	).catch(() => null);

	// `settled` used to be set BEFORE the write. That looked like simple
	// idempotency and was in fact the bug that made every other guard
	// here useless: when the Slack write stalled (no timeout, 30-minute
	// retry budget) the flag was already true, so the `finally` below
	// became a no-op and the founder sat on "_Thinking…_" indefinitely —
	// with the answer already generated. The flag now flips only once a
	// write has actually landed, and every write is bounded.
	let settled = false;
	const post = (text) =>
		softDeadline(
			client.chat.postMessage({ channel: message.channel, thread_ts: session.threadTs, text }).then(() => true),
			WRITE_DEADLINE_MS,
			"settle post",
			false,
		).catch(() => false);
	const settle = async (text) => {
		if (settled) return;
		// Update the placeholder in place when we have one — that's the
		// whole point of posting it. But a stalled update must not swallow
		// the answer, so fall back to a fresh message in the thread. Losing
		// the in-place edit is cosmetic; losing the reply is the failure.
		let ok = false;
		if (placeholderTs) {
			ok = await softDeadline(
				client.chat.update({ channel: message.channel, ts: placeholderTs, text }).then(() => true),
				WRITE_DEADLINE_MS,
				"settle update",
				false,
			).catch(() => false);
			if (!ok) console.error(`agent: placeholder update stalled for ${session.threadTs} — posting the reply separately`);
		}
		if (!ok) ok = await post(text);
		if (ok) settled = true;
		else console.error(`agent: could not deliver the reply for ${session.threadTs} at all`);
	};

	try {
		return await withDeadline(
			runTurnInner({ ...args, placeholderTs, settle, trace }),
			TURN_DEADLINE_MS,
			`turn ${session.threadTs}`,
		);
	} catch (err) {
		// A hang and a throw are reported differently, because they mean
		// different things to the founder: one is worth retrying as-is,
		// the other usually isn't. Both name the phase they died in, so
		// the next one is diagnosable from the log instead of from /proc.
		const stalled = err instanceof DeadlineError;
		console.error(
			`agent: turn ${stalled ? "STALLED" : "threw"} (${session.threadTs}) in phase "${trace.last()}" after ${trace.elapsed()}ms: ${err.stack || err.message}`,
		);
		await settle(
			stalled
				? `_This turn stalled at "${trace.last()}" and I've stopped waiting on it. Nothing was saved — worth sending again._`
				: "_That turn failed and nothing was saved. Worth trying again — if it keeps happening, say so._",
		);
		return true;
	} finally {
		// Reached when the loop exhausted without ever answering.
		await settle(
			"_I couldn't get a reply out for that one. Nothing was saved. Try rephrasing, or ask for one thing at a time._",
		);
		trace.step("done");
	}
}

async function runTurnInner({ session, message, client, placeholderTs, settle, trace, askChain = 0 }) {
	const isProject = session.kind === "project";
	const ideaId = session.ideaId || null;
	const stageName = isProject ? "project_turn" : "chat";

	const ctx = {
		founder: session.ownerFounder,
		channelId: message.channel,
		userId: message.user,
		threadTs: session.threadTs,
		client,
		inChats: !isProject,
		project: isProject && ideaId ? readState(ideaId) : null,
		// Carried so `ask` can refuse to start an interrogation: a question
		// answered produces another turn, which could ask again.
		askChain,
		assumption: isProject && ideaId ? readAssumption(ideaId) : null,
		research: isProject && ideaId ? readLatestResearch(ideaId) : null,
	};

	const text = message.text.trim();

	// The chat's mode decides WHO replies, not just which document gets
	// fed. Before this, mode changed the card label and the document
	// routing while every reply still came from one generic prompt -- so
	// the persona refusals (the PM declining to prescribe implementation,
	// the engineer declining to reopen product decisions) only ever fired
	// when a document was generated, never in the conversation where they
	// actually bite. The persona is layered ON TOP of the agent loop
	// rather than replacing it, so an engineer can still run `find` or
	// `proto`: same one-loop architecture (D-53), different voice and
	// different refusals.
	const mode = sessionMode(session);
	const persona = personaFor(mode);
	const personaBrief =
		`You are in *${mode}* mode, acting as the ${persona.label}. This role and its refusals take precedence ` +
		`over the general guidance above: if the founder asks for something this role refuses, refuse it in the ` +
		`REFUSAL:/UNBLOCK: form rather than complying, even when the request is reasonable and even when you could ` +
		`answer it. Check the request against the documents you were given before answering.\n\n${persona.systemPrompt}`;
	// Role FIRST, mechanics second. SYSTEM_PROMPT is ~40 lines of tool
	// routing written when there was a single generic assistant; leading
	// with it framed every reply as "generic Mill deciding whether to call
	// a tool", and the persona arriving later never displaced that. The
	// role is what the founder is talking to; the tool rules are how it
	// operates. A short restatement still trails the context so the
	// refusals sit next to the live turns as well.
	// THE REFUSAL GATE, run AFTER the loop rather than before it.
	//
	// Measured, not assumed (D-55): with an identical message list the
	// persona refuses correctly when called WITHOUT tools and emits a bare
	// tool call when the same messages are sent WITH tools. Offering a tool
	// set pulls the model toward acting rather than declining. That finding
	// stands; what was wrong was running the check FIRST.
	//
	// Running it first made it decide something it cannot see: whether the
	// turn is a document write. A founder asking to modify the spec got the
	// whole turn replaced by a refusal, so the `save` -- which now asks per
	// item for what's missing rather than refusing over it -- never ran. And
	// because the check reads the thread, two earlier refusals for the same
	// message biased it toward a third: the same momentum problem D-52
	// recorded for command routing.
	//
	// So the loop decides first. If it calls a tool, that command owns the
	// turn and enforces its own gates (a save asks or refuses per item). Only
	// when the turn is about to answer in PROSE -- the case the gate was
	// actually built for -- is the role asked, with no tools, whether it
	// refuses. Cheaper too: a tool turn now makes one model call, not two.
	const refusalCheck = async () => {
		if (mode === "brainstorm") return null;
		trace.step(`refusal check (${mode})`);
		const veto = await callFlash(
			[
				{ role: "system", content: personaBrief },
				...buildContextMessages(session),
				{
					role: "system",
					content:
						"Does this role refuse the founder's latest message? Answer `PROCEED` if it can engage " +
						"normally, or `REFUSAL:` then `UNBLOCK:` lines if it refuses. Judge the LATEST message " +
						"only: an earlier refusal in this thread is not a reason to refuse again.",
				},
				{ role: "user", content: text },
			],
			// 4096, not 700. The refusal shares this budget with reasoning
			// (D-08): at 700 a real call spent 675 tokens thinking and was
			// truncated before its UNBLOCK line, so the founder got an
			// accusation with no way forward. llm.js floors this too now.
			{ model: MODEL, maxTokens: 4096 },
		).catch((err) => {
			// A failed check must never block the turn.
			console.error(`agent: refusal check failed (${session.threadTs}): ${err.message}`);
			return null;
		});
		const refusal = veto && parseRefusal(veto.content);
		// A refusal with no UNBLOCK is a dead end, which the persona contract
		// forbids in as many words. Treat it as malformed rather than passing
		// the defect to the founder.
		if (refusal && !refusal.unblock) {
			console.error(`agent: incomplete refusal (no UNBLOCK) in ${mode} for ${session.threadTs} — ignoring: ${String(veto.content).slice(0, 120)}`);
			return null;
		}
		return refusal ? { refusal, veto } : null;
	};

	const messages = [
		{ role: "system", content: personaBrief },
		{ role: "system", content: SYSTEM_PROMPT },
		...buildContextMessages(session, {
			trailingSystem:
				`Reminder: you are the ${persona.label} (*${mode}* mode). Before replying, check the founder's latest ` +
				`message against this role's refusals. If it asks for something this role does not do, answer with ` +
				`REFUSAL: / UNBLOCK: and nothing else — do not quietly do adjacent work instead.`,
		}),
	];

	let costUsd = 0;
	let tokensIn = 0;
	let tokensOut = 0;
	let cacheHits = 0;
	let calls = 0;
	const toolsCalled = [];
	let toolsIgnored = 0;
	let searchInitiatedBy = null; // "agent" (inline quick) | "founder" (broad) | null
	const t0 = Date.now();

	// Deterministic backstop: an explicit "research this / look this up /
	// dig into that" imperative runs `find` broad directly -- the model
	// has been unreliable on these in long threads.
	if (shouldForceBroadFind(text)) {
		trace.step("forced broad find");
		if (placeholderTs) await client.chat.update({ channel: message.channel, ts: placeholderTs, text: "_On it — researching that…_" }).catch(() => {});
		const before = session.turns.length;
		const out = await runTool("find", { query: text, mode: "broad" }, { ...ctx, progressTs: placeholderTs, progressChannel: message.channel });
		if (out.search) searchInitiatedBy = out.search;
		if (session.turns.length === before) addTurn(session, { role: "assistant", text: "[ran `find` (broad) — report is in the thread]", kind: "command" });
		if (!out.posted && placeholderTs) {
			await client.chat.update({ channel: message.channel, ts: placeholderTs, text: `_${out.result}_` }).catch(() => {});
		}
		emit(
			buildEvalEvent({
				stage: stageName, model: MODEL, founder: session.ownerFounder, ideaId, reasonCode: `mode_${mode}`,
				wallClockS: (Date.now() - t0) / 1000, status: "ok", reasonCode: "forced_broad_find",
				toolsCalled: ["find"], toolsIgnored: 0, iterations: 0, repliedWithoutTool: false,
				searchInitiatedBy: searchInitiatedBy || "founder",
			}),
		);
		return true;
	}

	for (let step = 0; step < MAX_STEPS; step++) {
		let res;
		trace.step(`model call ${step + 1}/${MAX_STEPS}`);
		try {
			res = await callFlashTools(messages, { model: MODEL, maxTokens: 2048, tools: toolSpecs() });
		} catch (err) {
			console.error(`agent: model call failed (${session.threadTs}): ${err.message}`);
			emit(buildEvalEvent({ stage: stageName, model: MODEL, founder: session.ownerFounder, ideaId, status: "failed", reasonCode: "model_call_failed", toolsCalled: [], iterations: step + 1, repliedWithoutTool: false }));
			const m = `_(couldn't generate a reply: ${err?.message || err})_`;
			await settle(m);
			return true;
		}
		calls += 1;
		costUsd += res.costUsd || 0;
		tokensIn += res.usage?.prompt_tokens ?? 0;
		tokensOut += res.usage?.completion_tokens ?? 0;
		if (res.cacheHit) cacheHits += 1;

		// ---- tool call: run the first, ignore the rest (founder-paced) ----
		if (res.toolCalls.length) {
			const tc = res.toolCalls[0];
			toolsIgnored += res.toolCalls.length - 1;
			const name = tc.function?.name;
			const args = parseArgs(tc);
			toolsCalled.push(name);

			const before = session.turns.length;
			trace.step(`tool ${name}`);
			const out = await runTool(name, args, { ...ctx, progressTs: placeholderTs, progressChannel: message.channel });
			trace.step(`tool ${name} returned (posted=${!!out.posted})`);
			if (out.search) searchInitiatedBy = out.search; // "agent" (inline) | "founder" (broad)

			// Keep the thread transcript continuous even when the handler
			// (project-stage branch) didn't record its own turn -- else the
			// next turn's context shows two user messages back to back and
			// the model re-reads stale intent.
			if (session.turns.length === before) {
				addTurn(session, { role: "assistant", text: `[ran \`${name}\` — output is in the thread]`, kind: "command" });
			}

			if (out.posted) {
				// The command put its output in the thread and owns the
				// response. Stop -- no framing round-trip (D-52 Root Cause A).
				emit(
					buildEvalEvent({
						stage: stageName, model: MODEL, founder: session.ownerFounder, ideaId,
						tokensIn, tokensOut, costUsd, cacheHitRatio: calls ? cacheHits / calls : 0,
						wallClockS: (Date.now() - t0) / 1000, status: "ok", reasonCode: `tool_${name}`,
						toolsCalled, toolsIgnored, iterations: step + 1, repliedWithoutTool: false,
						searchInitiatedBy,
					}),
				);
				return true;
			}

			// Blocked by a precondition or errored -- nothing is in the
			// thread. Loop once so the model relays it to the founder.
			messages.push({ role: "assistant", content: null, tool_calls: [tc] });
			messages.push({ role: "tool", tool_call_id: tc.id, content: out.result });
			continue;
		}

		// ---- plain reply ----
		const replyText = (res.content || "").trim();
		if (!replyText) {
			// no content, no tool -- give it one more step, then bail
			messages.push({ role: "user", content: "(You returned nothing. Reply in prose, or call a tool.)" });
			continue;
		}

		// The turn is about to answer in prose -- the case the refusal gate
		// exists for (a tool call, by contrast, is owned by its command and
		// enforces its own gates). Ask the role now, with no tools present.
		const vetoed = await refusalCheck();
		if (vetoed) {
			const body = `REFUSAL: ${vetoed.refusal.what}\nUNBLOCK: ${vetoed.refusal.unblock}`;
			await settle(body);
			addTurn(session, { role: "assistant", text: body });
			emit(buildEvalEvent({
				stage: stageName, model: MODEL, founder: session.ownerFounder, ideaId,
				tokensIn: tokensIn + (vetoed.veto.usage?.prompt_tokens ?? 0),
				tokensOut: tokensOut + (vetoed.veto.usage?.completion_tokens ?? 0),
				costUsd: costUsd + (vetoed.veto.costUsd ?? 0), status: "ok",
				reasonCode: `persona_refusal_${mode}`, toolsCalled, iterations: step + 1, repliedWithoutTool: true,
			}));
			return true;
		}

		// D-53 Mode 1: an agent-initiated inline search ran this turn --
		// guarantee the not-evidence marker even if the model forgot it.
		const finalReply =
			searchInitiatedBy === "agent" && !NOT_EVIDENCE_RE.test(replyText)
				? `${replyText}\n\n${INLINE_MARKER}`
				: replyText;

		addTurn(session, { role: "assistant", text: finalReply });
		// No promote button on individual turns: it belongs on the card at
		// the top of the thread, once, not repeated down every reply.
		let postedTs = placeholderTs;
		trace.step("settle reply");
		await settle(finalReply);
		if (!placeholderTs) postedTs = null;

		// A plain conversational turn now counts as activity: it moves the
		// pin to this chat and refreshes its card (including the
		// "continue where you left off" link). Previously only COMMANDS did
		// this, so "the last active chat is pinned" was false for any
		// project where the recent work was conversation.
		if (isProject && ideaId) {
			try {
				const { touchAndRepin } = require("./chat-card");
				trace.step("repin card");
				await softDeadline(touchAndRepin(client, ideaId, session.threadTs, { latestTs: postedTs }), 30_000, "repin card");
			} catch (err) {
				console.error(`agent: chat touch failed (${session.threadTs}): ${err.message}`);
			}
		}

		try {
			trace.step("compact");
			const marker = await softDeadline(maybeCompact(session), 60_000, "compaction");
			if (marker) await client.chat.postMessage({ channel: message.channel, thread_ts: session.threadTs, text: marker }).catch(() => {});
		} catch (err) {
			console.error(`agent: compaction failed (${session.threadTs}): ${err.message}`);
		}

		emit(
			buildEvalEvent({
				stage: stageName,
				model: MODEL,
				founder: session.ownerFounder,
				ideaId,
				tokensIn,
				tokensOut,
				costUsd,
				cacheHitRatio: calls ? cacheHits / calls : 0,
				wallClockS: (Date.now() - t0) / 1000,
				status: "ok",
				reasonCode: session.stage ? `stage_${session.stage}` : "turn",
				toolsCalled,
				toolsIgnored,
				iterations: step + 1,
				repliedWithoutTool: true,
				searchInitiatedBy,
			}),
		);
		return true;
	}

	// Ran out of steps without a plain reply or a tool call.
	const m = "_(couldn't settle on a response — try rephrasing)_";
	await settle(m);
	emit(buildEvalEvent({ stage: stageName, model: MODEL, founder: session.ownerFounder, ideaId, tokensIn, tokensOut, costUsd, cacheHitRatio: calls ? cacheHits / calls : 0, wallClockS: (Date.now() - t0) / 1000, status: "failed", reasonCode: "max_steps", toolsCalled, iterations: MAX_STEPS, repliedWithoutTool: false }));
	return true;
}

module.exports = { runTurn, SYSTEM_PROMPT };
