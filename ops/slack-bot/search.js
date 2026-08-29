"use strict";

// D-53 research modes.
//
// Mode 1 (this file) -- inline surface search, agent-initiated. The agent
// loop calls it mid-conversation when it needs ONE concrete missing fact
// (a price, a rule, a market number, whether a named company exists). 1-2
// Tavily queries, returned as a compact string the model folds into its
// prose reply. It never posts a separate Slack block -- agent.js appends
// the not-evidence marker to the reply.
//
// Mode 2 (broad, founder-pushed) lives in commands/find.js's runFind with
// broad:true -- more sub-queries, more results per query, posted as the
// visibly-distinct surface-search block. Still not a research pass.

const { search } = require("./tavily");

// The agent passes a concrete standalone query. Split a compound one
// ("X price and Y regulation") on ';' or a newline; cap at 2.
function splitQueries(query) {
	return String(query || "")
		.split(/;|\n/)
		.map((q) => q.trim())
		.filter(Boolean)
		.slice(0, 2);
}

async function inlineFactSearch(query) {
	const queries = splitQueries(query);
	if (!queries.length) return { findings: "(no query)", queryCount: 0 };

	let hits;
	try {
		hits = await search(queries, { maxQueries: 2, maxResults: 3 });
	} catch (err) {
		return { findings: `(web check failed: ${err?.message || err})`, queryCount: 0 };
	}

	const blocks = hits.map((h) => {
		const top = (h.results || [])
			.slice(0, 3)
			.map((r) => `- ${r.title}: ${String(r.content || "").replace(/\s+/g, " ").slice(0, 220)} (${r.url})`)
			.join("\n");
		return `Query: ${h.query}\n${h.answer ? `Answer: ${h.answer}\n` : ""}${top}`;
	});

	return { findings: blocks.join("\n\n").slice(0, 1600), queryCount: queries.length };
}

module.exports = { inlineFactSearch };
