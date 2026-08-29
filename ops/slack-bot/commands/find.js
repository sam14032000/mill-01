"use strict";

const { founderForUserId, channelId } = require("../config");
const { callFlash } = require("../llm");
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");
const { search } = require("../tavily");
const { getSession, findLatestSessionForUser, addTurn } = require("../chat-session");
const { withPromoteButton } = require("../promote-button");
const { isAnaphoric } = require("../intent");
const { postResult } = require("../reply");

const MODEL = "flash-fast";
const STAGE = "find";

// PROJECTS.md 14.5 / build-guide-projects 14.5: surface web search, 1-3
// queries, summarised inline. NOT evidence -- no report file, no citation
// re-check, no evidence_basis. Output must be visually distinct from a
// research report and carry a footer saying so. This distinction is
// load-bearing: /find masquerading as research routes around the
// audit's web-only cap.
const NOT_EVIDENCE_FOOTER =
	"\n\n---\n> 🔎 _Surface search, not research. No sources were verified and this is *not evidence*. " +
	"Only `/test` inside a project produces something an audit can rule on._";

const QUERY_PLANNER_PROMPT = [
	"Turn this into 1 to 3 focused web search queries. More than one only if the ask has genuinely distinct parts.",
	"Output only the queries, one per line, no numbering, no commentary.",
].join("\n");

const SUMMARY_PROMPT = [
	"Summarise these web search results for a founder thinking through an idea.",
	"Lead with the direct answer if there is one. Note where sources disagree or where the evidence is thin.",
	"Be brief. Plain prose. Do not present this as verified fact -- it is a surface scan.",
].join("\n");

// ROOT CAUSE B: "research these problem statements" / "look this up" only
// mean something against the conversation. When the ask is anaphoric or
// too thin to stand alone AND we have thread context, resolve it to a
// concrete standalone subject before planning queries. Returns the
// resolved subject (or the original text if there's nothing to resolve
// against / the call fails).
const RESOLVE_PROMPT = [
	"A founder in a chat asked for a web search. Their exact words may lean on the conversation ('research these', 'look this up', 'what we discussed').",
	"Using the conversation, restate WHAT TO SEARCH FOR as a single concrete, standalone subject — a phrase or question a search engine could take with no other context.",
	"Resolve every referring expression against the conversation. Do not add scope they didn't ask for. Output only the resolved subject, one line, no preamble.",
].join("\n");

async function resolveTopic(rawTopic, threadContext) {
	if (!threadContext || !isAnaphoric(rawTopic)) return rawTopic;
	try {
		const { content } = await callFlash(
			[
				{ role: "system", content: RESOLVE_PROMPT },
				{ role: "user", content: `Conversation:\n${threadContext}\n\nThe founder's search request: "${rawTopic}"` },
			],
			{ model: MODEL, maxTokens: 256 },
		);
		const resolved = (content || "").trim().split("\n")[0].trim();
		return resolved.length >= 3 ? resolved : rawTopic;
	} catch {
		return rawTopic;
	}
}

async function planQueries(topic) {
	try {
		const { content } = await callFlash(
			[
				{ role: "system", content: QUERY_PLANNER_PROMPT },
				{ role: "user", content: topic },
			],
			{ model: MODEL, maxTokens: 512 },
		);
		const lines = (content || "")
			.split("\n")
			.map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
			.filter(Boolean);
		return lines.length ? lines.slice(0, 3) : [topic];
	} catch {
		return [topic];
	}
}

async function runFind(topic, { rawTopic } = {}) {
	const queries = await planQueries(topic);
	const t0 = Date.now();
	const hits = await search(queries);

	const corpus = hits
		.map((h) => {
			const items = h.results
				.map((r) => `- ${r.title} (${r.url})\n  ${r.content}`)
				.join("\n");
			return `Query: ${h.query}\n${h.answer ? `Tavily answer: ${h.answer}\n` : ""}${items}`;
		})
		.join("\n\n");

	const { content, usage, costUsd, cacheHit } = await callFlash(
		[
			{ role: "system", content: SUMMARY_PROMPT },
			{ role: "user", content: corpus || "(no results returned)" },
		],
		{ model: MODEL, maxTokens: 2048 },
	);
	const wallClockS = (Date.now() - t0) / 1000;

	const sourceList = hits
		.flatMap((h) => h.results.map((r) => r.url))
		.filter((u, i, a) => a.indexOf(u) === i)
		.slice(0, 8);

	const body =
		`*🔎 Surface search:* ${topic}\n` +
		(rawTopic && rawTopic !== topic ? `_(you asked: “${rawTopic}” — resolved from the thread)_\n` : "") +
		`_Queries: ${queries.map((q) => `\`${q}\``).join(", ")}_\n\n` +
		`${content || "_no usable results_"}` +
		(sourceList.length ? `\n\n_Scanned:_ ${sourceList.map((u) => `<${u}>`).join(" · ")}` : "") +
		NOT_EVIDENCE_FOOTER;

	return {
		body,
		queryCount: queries.length,
		tokensIn: usage?.prompt_tokens ?? 0,
		tokensOut: usage?.completion_tokens ?? 0,
		costUsd,
		cacheHitRatio: cacheHit ? 1 : 0,
		wallClockS,
	};
}

async function handleFindCommand({ command, ack, client }) {
	const founder = founderForUserId(command.user_id);
	if (!founder) {
		await ack(); // D-40
		return;
	}

	const topic = (command.text || "").trim();
	if (!topic) {
		await ack({ response_type: "ephemeral", text: "`/find` needs a query: `/find <what to look up>`" });
		return;
	}

	await ack();

	// Thread it into whatever session this thread has -- a #chats chat or
	// a project stage thread (ROOT CAUSE B: /find was project-blind and
	// posted to channel root there). Fall back to the founder's active
	// #chats session for a bare slash command with no thread_ts.
	const chatsChannel = channelId("chats");
	const session =
		(command.thread_ts && getSession(command.thread_ts)) ||
		(command.channel_id === chatsChannel
			? findLatestSessionForUser(command.user_id, chatsChannel)
			: null);
	const threadTs = command.thread_ts || (session ? session.threadTs : undefined);
	const dest = command.channel_id || channelId("mill");

	try {
		// ROOT CAUSE B: resolve "these"/"this"/thin asks against the thread
		// before planning queries.
		const resolved = await resolveTopic(topic, command.thread_context);
		const r = await runFind(resolved, { rawTopic: topic });

		const post = { channel: dest, text: r.body };
		if (threadTs) {
			post.thread_ts = threadTs;
			post.blocks = withPromoteButton(r.body, threadTs); // 15.1
		}
		await postResult(client, post);

		if (session) {
			addTurn(session, { role: "user", text: `/find ${topic}`, userId: command.user_id, kind: "command" });
			addTurn(session, { role: "assistant", text: r.body, kind: "command" });
		}

		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder,
				tokensIn: r.tokensIn,
				tokensOut: r.tokensOut,
				costUsd: r.costUsd,
				cacheHitRatio: r.cacheHitRatio,
				wallClockS: r.wallClockS,
				status: "ok",
				reasonCode: `queries_${r.queryCount}`,
			}),
		);
	} catch (err) {
		console.error("find command failed:", err);
		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder,
				status: "failed",
				reasonCode: "find_failed",
			}),
		);
		await client.chat
			.postMessage({ channel: dest, text: `\`/find\` failed: ${err?.message || err}` })
			.catch(() => {});
	}
}

module.exports = { handleFindCommand, runFind };
