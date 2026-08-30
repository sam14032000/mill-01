"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { founderForUserId, channelId } = require("../config");
const { callFlash } = require("../llm");
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");
const { search } = require("../tavily");
const { getSession, findLatestSessionForUser, addTurn } = require("../chat-session");
const { withPromoteButton } = require("../promote-button");
const { isAnaphoric } = require("../intent");
const { postResult } = require("../reply");
const { findIdeaByChannel, IDEAS_DIR, nowIso } = require("../ideas");
const { commitAndPush } = require("../git");
const { uploadThreadFile } = require("../slack-files");

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

const queryPlannerPrompt = (max) =>
	[
		`Turn this into 1 to ${max} focused web search queries. More than one only if the ask has genuinely distinct parts to cover.`,
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

async function planQueries(topic, { max = 3 } = {}) {
	try {
		const { content } = await callFlash(
			[
				{ role: "system", content: queryPlannerPrompt(max) },
				{ role: "user", content: topic },
			],
			{ model: MODEL, maxTokens: 512 },
		);
		const lines = (content || "")
			.split("\n")
			.map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
			.filter(Boolean);
		return lines.length ? lines.slice(0, max) : [topic];
	} catch {
		return [topic];
	}
}

function findStamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// broad (D-53 Mode 2, founder-pushed): more distinct sub-queries and more
// results per query -- breadth, not recursion depth (still search_depth
// "basic", still NOT a research pass). Returns the raw pieces; the
// caller either writes a report file (project) or posts a capped inline
// message (#chats).
async function runFind(topic, { rawTopic, broad = false } = {}) {
	const maxQueries = broad ? 5 : 3;
	const maxResults = broad ? 8 : 5;
	const shortTopic = String(topic || "").replace(/\s+/g, " ").trim().slice(0, 300);
	const rawTrim = String(rawTopic || "").replace(/\s+/g, " ").trim();
	const queries = await planQueries(shortTopic, { max: maxQueries });
	const t0 = Date.now();
	const hits = await search(queries, { maxQueries, maxResults });

	const corpus = hits
		.map((h) => {
			const items = h.results
				.map((r) => `- ${r.title} (${r.url})\n  ${String(r.content || "").slice(0, 800)}`)
				.join("\n");
			return `Query: ${h.query}\n${h.answer ? `Tavily answer: ${h.answer}\n` : ""}${items}`;
		})
		.join("\n\n")
		.slice(0, 40000);

	const { content, usage, costUsd, cacheHit } = await callFlash(
		[
			{ role: "system", content: SUMMARY_PROMPT },
			{ role: "user", content: corpus || "(no results returned)" },
		],
		{ model: MODEL, maxTokens: 2048 },
	);
	const wallClockS = (Date.now() - t0) / 1000;

	const sources = hits
		.flatMap((h) => h.results.map((r) => ({ title: r.title, url: r.url })))
		.filter((s, i, a) => a.findIndex((x) => x.url === s.url) === i);

	const summary = String(content || "_no usable results_").trim();

	// Capped inline message -- used only when there's no project to store
	// a report file in (#chats). Section renders to ~3000 chars; keep the
	// footer.
	const head =
		`*🔎 Surface search${broad ? " (broad)" : ""}:* ${shortTopic}\n` +
		(rawTrim && rawTrim !== shortTopic ? `_(searched: “${shortTopic}”)_\n` : "") +
		`_Queries: ${queries.map((q) => `\`${String(q).slice(0, 80)}\``).join(", ").slice(0, 300)}_\n\n`;
	const srcLine = sources.length ? `\n\n_Scanned:_ ${sources.slice(0, 4).map((s) => `<${s.url}>`).join(" · ")}` : "";
	const room = 2650 - head.length - srcLine.length - NOT_EVIDENCE_FOOTER.length;
	const body = head + summary.slice(0, Math.max(200, room)) + srcLine + NOT_EVIDENCE_FOOTER;

	return {
		body,
		shortTopic,
		rawTrim,
		queries,
		summary,
		sources,
		queryCount: queries.length,
		tokensIn: usage?.prompt_tokens ?? 0,
		tokensOut: usage?.completion_tokens ?? 0,
		costUsd,
		cacheHitRatio: cacheHit ? 1 : 0,
		wallClockS,
	};
}

// Write the full report to ideas/<id>/find/<stamp>.md and append a
// one-line entry to ideas/<id>/find/index.md (the index is what every
// project thread sees -- readOriginContext loads it). Returns
// { relPath, absPath, stamp }.
function writeFindReport(id, { shortTopic, rawTrim, queries, summary, sources, founder }) {
	const dir = path.join(IDEAS_DIR, id, "find");
	fs.mkdirSync(dir, { recursive: true });
	const stamp = findStamp();
	const rel = `find/${stamp}.md`;
	const md = [
		`# Surface search — ${shortTopic}`,
		"",
		"> ⚠️ **Surface search, NOT evidence.** No sources verified. Only `/test` produces something an audit can rule on. Do not cite this as evidence.",
		"",
		`- **Run by:** ${founder}`,
		`- **When:** ${nowIso()}`,
		rawTrim && rawTrim !== shortTopic ? `- **Asked:** ${rawTrim}` : null,
		`- **Queries:** ${queries.map((q) => `\`${q}\``).join(" · ")}`,
		"",
		"## Summary",
		"",
		summary,
		"",
		"## Sources scanned",
		"",
		...(sources.length ? sources.map((s) => `- [${s.title || s.url}](${s.url})`) : ["- (none returned)"]),
		"",
	]
		.filter((l) => l !== null)
		.join("\n");
	fs.writeFileSync(path.join(dir, `${stamp}.md`), md, "utf8");

	// Index: one line per report, newest last.
	const blurb = summary.replace(/\s+/g, " ").slice(0, 180);
	const indexLine = `- **${stamp}** — ${shortTopic}\n  ${blurb}${blurb.length >= 180 ? "…" : ""}  \n  → \`ideas/${id}/${rel}\`\n`;
	const indexPath = path.join(dir, "index.md");
	if (!fs.existsSync(indexPath)) {
		fs.writeFileSync(indexPath, `# Surface-search reports — ${id}\n\n_Surface search, NOT evidence. Referenceable from any thread in this project._\n\n`, "utf8");
	}
	fs.appendFileSync(indexPath, indexLine, "utf8");

	return { relPath: `ideas/${id}/${rel}`, absPath: path.join(dir, `${stamp}.md`), stamp };
}

// The Slack message that accompanies the attached report -- a rundown
// that fits Slack's block limit.
function findRundown({ shortTopic, summary, sources, relPath, broad }) {
	const head = `*🔎 Surface search${broad ? " (broad)" : ""}:* ${shortTopic}\n📄 Full report saved to \`${relPath}\`\n\n`;
	const src = sources.length
		? `\n\n_Top sources:_ ${sources.slice(0, 5).map((s) => `<${s.url}|${(s.title || s.url).slice(0, 40)}>`).join(" · ")}`
		: "";
	const room = 2700 - head.length - src.length - NOT_EVIDENCE_FOOTER.length;
	let rundown = summary;
	if (rundown.length > room) rundown = `${rundown.slice(0, Math.max(200, room - 20))}\n\n_…full report attached._`;
	return head + rundown + src + NOT_EVIDENCE_FOOTER;
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

	// Founder-invoked /find (slash, @Mill, or the agent's broad mode) is
	// founder-pushed by definition -> broad breadth.
	const broad = command.broad !== false;
	// A project (any stage thread) -> the full report is written to a
	// file and referenceable from every thread; Slack gets a rundown +
	// the attachment. #chats (no project) -> capped inline message.
	const project = command.channel_id ? findIdeaByChannel(command.channel_id) : null;

	try {
		// ROOT CAUSE B: resolve "these"/"this"/thin asks against the thread
		// before planning queries.
		const resolved = await resolveTopic(topic, command.thread_context);
		const r = await runFind(resolved, { rawTopic: topic, broad });

		let posted;
		let reportRel = null;
		if (project) {
			const rep = writeFindReport(project.id, {
				shortTopic: r.shortTopic,
				rawTrim: r.rawTrim,
				queries: r.queries,
				summary: r.summary,
				sources: r.sources,
				founder,
			});
			reportRel = rep.relPath;
			await commitAndPush(
				[`ideas/${project.id}/find`],
				`idea ${project.id}: surface-search report ${rep.stamp} by ${founder}`,
				(why) => console.error(`git commit/push failed for ${project.id} find report: ${why}`),
			);

			const rundown = findRundown({ shortTopic: r.shortTopic, summary: r.summary, sources: r.sources, relPath: rep.relPath, broad });
			posted = await postResult(client, {
				channel: dest,
				...(threadTs ? { thread_ts: threadTs } : {}),
				text: rundown,
				blocks: threadTs ? withPromoteButton(rundown, threadTs) : undefined,
			});

			// Attach the markdown report to the thread. Needs the
			// `files:write` scope -- degrades to "saved to <path>" (already
			// in the rundown) without it.
			await uploadThreadFile(client, {
				channel: dest,
				thread_ts: threadTs,
				filename: `${rep.stamp}.md`,
				title: `Surface search — ${r.shortTopic}`.slice(0, 250),
				content: fs.readFileSync(rep.absPath, "utf8"),
				initial_comment: null,
			});

			if (session) {
				addTurn(session, { role: "user", text: `/find ${topic}`, userId: command.user_id, kind: "command" });
				addTurn(session, { role: "assistant", text: `Surface-search report written to \`${rep.relPath}\` (referenceable from any thread). ${r.summary.replace(/\s+/g, " ").slice(0, 400)}`, kind: "command" });
			}
		} else {
			// #chats: no project to store a report in -> capped inline.
			posted = await postResult(client, {
				channel: dest,
				...(threadTs ? { thread_ts: threadTs, blocks: withPromoteButton(r.body, threadTs) } : {}),
				text: r.body,
			});
			if (session) {
				addTurn(session, { role: "user", text: `/find ${topic}`, userId: command.user_id, kind: "command" });
				addTurn(session, { role: "assistant", text: r.body, kind: "command" });
			}
		}
		void posted;

		emit(
			buildEvalEvent({
				stage: STAGE,
				model: MODEL,
				founder,
				ideaId: project ? project.id : null,
				tokensIn: r.tokensIn,
				tokensOut: r.tokensOut,
				costUsd: r.costUsd,
				cacheHitRatio: r.cacheHitRatio,
				wallClockS: r.wallClockS,
				status: "ok",
				reasonCode: `${broad ? "broad" : "quick"}_q${r.queryCount}${reportRel ? "_report" : ""}`,
				searchInitiatedBy: "founder",
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
		// Land it in the "Thinking…" placeholder (postResult redirect) /
		// the thread, not at channel root.
		await postResult(client, {
			channel: dest,
			...(threadTs ? { thread_ts: threadTs } : {}),
			text: `\`/find\` failed: ${err?.message || err}`,
		}).catch(() => {});
	}
}

module.exports = { handleFindCommand, runFind };
