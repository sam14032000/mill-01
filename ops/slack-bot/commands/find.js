"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { founderForUserId, channelId } = require("../config");
const { callFlash } = require("../llm");
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");
const { search } = require("../tavily");
const { getSession, findLatestSessionForUser, addTurn } = require("../chat-session");
const { withPromoteButtonIfChat } = require("../promote-button");
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

// Two generations for a broad /find, D-53: a full report (written to the
// file, at whatever length the evidence supports) and then a separate
// short summary of that report (the Slack message). The Slack summary is
// NEVER the source of the file.
const REPORT_PROMPT = [
	"You are writing a thorough surface-search briefing for a founder, from the web search results below. This goes into a project file, so write it in full — as long as the evidence supports. Do not artificially shorten.",
	"Organise with Markdown headings. Cover: the direct answer to what was searched; what each cluster of sources actually says; every named company / product / service and any price, fee, or figure mentioned; where sources agree; where they disagree or contradict; and what the results do NOT tell you (gaps that would need a real conversation or a proper research pass).",
	"Do not invent anything not in the results. Do not present any of it as verified fact — it is an unverified surface scan.",
	"Do not add a top-level title or a sources list — those are added around your text. Start straight into the briefing.",
].join("\n");

const RUNDOWN_PROMPT = [
	"Summarise this surface-search report for a short Slack message: about 180 words, plain prose, 2-4 short paragraphs, no headings.",
	"Lead with the direct answer. Keep the strongest named findings (companies, prices, the key contradiction or gap). End by noting the full report is attached.",
	"Do not present it as verified fact.",
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

// broad (D-53 Mode 2, founder-pushed): 5 sub-queries x 8 results --
// breadth, not depth (still search_depth "basic", still NOT a research
// pass). Two generations: `fullReport` (thorough, written to the file at
// whatever length the evidence supports) and `rundown` (a separate
// short summary OF that report -- the Slack message). The Slack rundown
// is never the source of the file.
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
				.map((r) => `- ${r.title} (${r.url})\n  ${String(r.content || "").slice(0, 1200)}`)
				.join("\n");
			return `Query: ${h.query}\n${h.answer ? `Tavily answer: ${h.answer}\n` : ""}${items}`;
		})
		.join("\n\n")
		.slice(0, 60000);

	const sources = hits
		.flatMap((h) => h.results.map((r) => ({ title: r.title, url: r.url })))
		.filter((s, i, a) => a.findIndex((x) => x.url === s.url) === i);

	let tokensIn = 0;
	let tokensOut = 0;
	let costUsd = 0;
	let calls = 0;
	let cacheHits = 0;
	const gen = async (system, user, maxTokens) => {
		const { content, usage, costUsd: c, cacheHit } = await callFlash(
			[
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			{ model: MODEL, maxTokens },
		);
		tokensIn += usage?.prompt_tokens ?? 0;
		tokensOut += usage?.completion_tokens ?? 0;
		costUsd += c ?? 0;
		calls += 1;
		if (cacheHit) cacheHits += 1;
		return String(content || "").trim();
	};

	const corpusOrEmpty = corpus || "(no results returned)";

	let fullReport = null;
	let rundown;
	if (broad) {
		// Generation 1: the full report -> the file.
		fullReport = (await gen(REPORT_PROMPT, `Search of: ${shortTopic}\n\nResults:\n${corpusOrEmpty}`, 8000)) || "_no usable results_";
		// Generation 2: a short summary OF that report -> Slack.
		rundown = (await gen(RUNDOWN_PROMPT, fullReport, 700)) || fullReport.slice(0, 1500);
	} else {
		// Non-broad (#chats shallow path, or an explicit narrow call):
		// one brief pass, used for the inline message.
		rundown = (await gen(SUMMARY_PROMPT, corpusOrEmpty, 2048)) || "_no usable results_";
	}
	const wallClockS = (Date.now() - t0) / 1000;

	// The capped inline message -- used only when there's no project to
	// store a report file in.
	const head =
		`*🔎 Surface search${broad ? " (broad)" : ""}:* ${shortTopic}\n` +
		(rawTrim && rawTrim !== shortTopic ? `_(searched: “${shortTopic}”)_\n` : "") +
		`_Queries: ${queries.map((q) => `\`${String(q).slice(0, 80)}\``).join(", ").slice(0, 300)}_\n\n`;
	const srcLine = sources.length ? `\n\n_Scanned:_ ${sources.slice(0, 4).map((s) => `<${s.url}>`).join(" · ")}` : "";
	const room = 2650 - head.length - srcLine.length - NOT_EVIDENCE_FOOTER.length;
	const body = head + rundown.slice(0, Math.max(200, room)) + srcLine + NOT_EVIDENCE_FOOTER;

	return {
		body, // inline message (#chats)
		rundown, // the Slack summary for the project path
		fullReport, // null unless broad -- the file's content
		shortTopic,
		rawTrim,
		queries,
		sources,
		queryCount: queries.length,
		tokensIn,
		tokensOut,
		costUsd,
		cacheHitRatio: calls ? cacheHits / calls : 0,
		wallClockS,
	};
}

// Write the full report (generation 1, NOT the Slack summary) to
// ideas/<id>/find/<stamp>.md and append a one-line entry to
// ideas/<id>/find/index.md (the index is what every project thread sees
// -- readOriginContext loads it). Returns { relPath, absPath, stamp }.
function writeFindReport(id, { shortTopic, rawTrim, queries, fullReport, blurbSource, sources, founder }) {
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
		fullReport,
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
	const blurb = String(blurbSource || fullReport).replace(/\s+/g, " ").slice(0, 180);
	const indexLine = `- **${stamp}** — ${shortTopic}\n  ${blurb}${blurb.length >= 180 ? "…" : ""}  \n  → \`ideas/${id}/${rel}\`\n`;
	const indexPath = path.join(dir, "index.md");
	if (!fs.existsSync(indexPath)) {
		fs.writeFileSync(indexPath, `# Surface-search reports — ${id}\n\n_Surface search, NOT evidence. Referenceable from any thread in this project._\n\n`, "utf8");
	}
	fs.appendFileSync(indexPath, indexLine, "utf8");

	return { relPath: `ideas/${id}/${rel}`, absPath: path.join(dir, `${stamp}.md`), stamp };
}

// The Slack message that accompanies the attached report. `rundown` is
// generation 2 -- already short (a summary OF the full report). We only
// hard-cap as a last resort; it should already fit.
function findRundown({ shortTopic, rundown, sources, relPath, broad }) {
	const head = `*🔎 Surface search${broad ? " (broad)" : ""}:* ${shortTopic}\n📄 Full report saved to \`${relPath}\` (attached)\n\n`;
	const src = sources.length
		? `\n\n_Top sources:_ ${sources.slice(0, 5).map((s) => `<${s.url}|${(s.title || s.url).slice(0, 40)}>`).join(" · ")}`
		: "";
	const room = 2700 - head.length - src.length - NOT_EVIDENCE_FOOTER.length;
	let text = String(rundown || "").trim();
	if (text.length > room) text = `${text.slice(0, Math.max(200, room - 20))}\n\n_…see the attached report._`;
	return head + text + src + NOT_EVIDENCE_FOOTER;
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
			// The FILE gets the full report (generation 1). If runFind
			// somehow produced no fullReport (non-broad path), fall back to
			// the rundown so the file is never empty -- but broad always
			// makes one.
			const rep = writeFindReport(project.id, {
				shortTopic: r.shortTopic,
				rawTrim: r.rawTrim,
				queries: r.queries,
				fullReport: r.fullReport || r.rundown || r.body,
				blurbSource: r.rundown,
				sources: r.sources,
				founder,
			});
			reportRel = rep.relPath;
			await commitAndPush(
				[`ideas/${project.id}/find`],
				`idea ${project.id}: surface-search report ${rep.stamp} by ${founder}`,
				(why) => console.error(`git commit/push failed for ${project.id} find report: ${why}`),
			);

			// The SLACK MESSAGE gets the rundown (generation 2) -- never
			// the file's source.
			const rundown = findRundown({ shortTopic: r.shortTopic, rundown: r.rundown, sources: r.sources, relPath: rep.relPath, broad });
			posted = await postResult(client, {
				channel: dest,
				...(threadTs ? { thread_ts: threadTs } : {}),
				text: rundown,
				blocks: withPromoteButtonIfChat(rundown, threadTs, dest),
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
				addTurn(session, { role: "assistant", text: `Surface-search report written to \`${rep.relPath}\` (referenceable from any thread). ${String(r.rundown || "").replace(/\s+/g, " ").slice(0, 400)}`, kind: "command" });
			}
		} else {
			// #chats: no project to store a report in -> capped inline.
			posted = await postResult(client, {
				channel: dest,
				...(threadTs ? { thread_ts: threadTs, blocks: withPromoteButtonIfChat(r.body, threadTs, dest) } : {}),
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
