"use strict";

// Direct Tavily search for /find (build-guide-projects Part 14.5).
// ops/research.py drives Tavily through GPT Researcher; the chat-tier
// /find is a shallow, inline lookup and doesn't need that machinery --
// 1-3 queries, basic depth, a handful of results each.
//
// This is NOT evidence (PROJECTS.md 14.5): the caller is responsible for
// the not-evidence framing and footer. This module only fetches.

const https = require("node:https");

const ENDPOINT = "https://api.tavily.com/search";
const MAX_RESULTS_PER_QUERY = 5;

function searchOne(query) {
	const key = process.env.TAVILY_API_KEY;
	if (!key) return Promise.reject(new Error("TAVILY_API_KEY not set"));

	const body = JSON.stringify({
		api_key: key,
		query,
		search_depth: "basic",
		max_results: MAX_RESULTS_PER_QUERY,
		include_answer: true,
	});

	return new Promise((resolve, reject) => {
		const req = https.request(
			ENDPOINT,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
				},
				timeout: 20_000,
			},
			(res) => {
				let buf = "";
				res.on("data", (c) => (buf += c));
				res.on("end", () => {
					if (res.statusCode !== 200) {
						reject(new Error(`Tavily HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
						return;
					}
					try {
						const data = JSON.parse(buf);
						resolve({
							query,
							answer: data.answer || null,
							results: (data.results || []).map((r) => ({
								title: r.title,
								url: r.url,
								content: r.content,
							})),
						});
					} catch (err) {
						reject(new Error(`Tavily parse error: ${err.message}`));
					}
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error("Tavily request timed out")));
		req.write(body);
		req.end();
	});
}

// Runs up to 3 queries. `queries` is a string[] (caller decides how many).
async function search(queries) {
	const capped = queries.slice(0, 3);
	return Promise.all(capped.map(searchOne));
}

module.exports = { search, searchOne, MAX_RESULTS_PER_QUERY };
