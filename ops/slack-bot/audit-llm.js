"use strict";

const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "http://127.0.0.1:4000";
const REQUEST_TIMEOUT_MS = 120_000;

// D-10, absolute: "Fable 5 runs at the audit gate and nowhere else.
// Never from a background job, never a profile default." This is the
// ONLY function in the codebase that reads MILL_AUDIT_KEY or calls the
// "audit" model -- kept in its own module rather than a branch inside
// llm.js so that isolation is structural (nothing else imports this
// file) rather than a convention someone has to remember not to break.
async function callAudit(messages, { maxTokens = 4096 } = {}) {
	const key = process.env.MILL_AUDIT_KEY;
	if (!key) throw new Error("MILL_AUDIT_KEY not set");

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	let res;
	try {
		res = await fetch(`${LITELLM_BASE_URL}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "audit",
				messages,
				max_tokens: maxTokens,
			}),
			signal: controller.signal,
		});
	} catch (err) {
		if (err.name === "AbortError") {
			throw new Error(`audit call timed out after ${REQUEST_TIMEOUT_MS}ms`);
		}
		throw err;
	} finally {
		clearTimeout(timeout);
	}

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`audit call failed: HTTP ${res.status} ${body.slice(0, 300)}`);
	}

	const data = await res.json();
	const content = data.choices?.[0]?.message?.content;
	if (typeof content !== "string" || !content.trim()) {
		throw new Error("audit call returned no content");
	}
	return { content, usage: data.usage };
}

module.exports = { callAudit };
