"use strict";

const { founderForUserId, channelId } = require("../config");
const { callFlash } = require("../llm");
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");
const { search } = require("../tavily");
const { findLatestSessionForUser, addTurn } = require("../chat-session");
const { withPromoteButton } = require("../promote-button");

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

async function runFind(topic) {
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

	// Thread it into the founder's active #chats session if there is one
	// (slash commands don't carry thread_ts -- see chat-session.js).
	const chatsChannel = channelId("chats");
	const session =
		command.channel_id === chatsChannel
			? findLatestSessionForUser(command.user_id, chatsChannel)
			: null;
	const dest = command.channel_id || channelId("mill");

	try {
		const r = await runFind(topic);

		const post = { channel: dest, text: r.body };
		if (session) {
			post.thread_ts = session.threadTs;
			post.blocks = withPromoteButton(r.body, session.threadTs); // 15.1
		}
		await client.chat.postMessage(post);

		if (session) {
			addTurn(session, { role: "user", text: `/find ${topic}`, userId: command.user_id });
			addTurn(session, { role: "assistant", text: r.body });
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
