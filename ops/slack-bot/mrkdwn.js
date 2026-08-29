"use strict";

// Slack does not parse standard Markdown. It uses its own "mrkdwn":
// *bold* (single asterisk), no headings, `•` for bullets. The models we
// call emit standard Markdown (**bold**, ## Heading, - bullet) no matter
// what the prompt says, so the asterisks and hashes show up literally in
// Slack. Rather than fight the model, convert on the way out.
//
// Scope is deliberately narrow — rendering only, no content change:
//   **x**  __x__   -> *x*
//   ## x  (any #)  -> *x*
//   - x   * x  + x -> • x   (line-start bullets only)
// Fenced code blocks and inline code spans are left untouched.

// Split off ``` fenced blocks so nothing inside them is rewritten.
function eachOutsideFences(text, fn) {
	const parts = String(text).split(/(```[\s\S]*?```)/g);
	return parts
		.map((seg) => (seg.startsWith("```") ? seg : fn(seg)))
		.join("");
}

// Protect `inline code` while transforming the rest of a segment.
function eachOutsideInlineCode(seg, fn) {
	const parts = seg.split(/(`[^`\n]*`)/g);
	return parts
		.map((p) => (p.startsWith("`") && p.endsWith("`") ? p : fn(p)))
		.join("");
}

function convertSegment(seg) {
	return eachOutsideInlineCode(seg, (s) => {
		// Line-level first: headings and bullets are anchored to line start.
		s = s
			.split("\n")
			.map((line) => {
				// ## Heading  ->  *Heading*   (drop trailing #'s too)
				const h = line.match(/^(\s{0,3})#{1,6}\s+(.*?)\s*#*\s*$/);
				if (h) {
					const body = h[2].trim();
					return body ? `${h[1]}*${body}*` : h[1];
				}
				// "- ", "* ", "+ " bullet  ->  "• "   (keep indent; leave
				// "**" alone — that's bold, handled below)
				const b = line.match(/^(\s*)([-*+])\s+(?!\*|[-*+]\s)(.*)$/);
				if (b) return `${b[1]}• ${b[3]}`;
				return line;
			})
			.join("\n");

		// Inline emphasis: **x** / __x__ -> *x*. Non-greedy, must have
		// content, must not span a newline.
		s = s.replace(/\*\*(?!\s)([^\n*]+?)(?<!\s)\*\*/g, "*$1*");
		s = s.replace(/__(?!\s)([^\n_]+?)(?<!\s)__/g, "*$1*");
		return s;
	});
}

function toSlackMrkdwn(text) {
	if (!text || typeof text !== "string") return text;
	return eachOutsideFences(text, convertSegment);
}

// Walk a Block Kit array and convert every mrkdwn text field in place.
function convertBlocks(blocks) {
	if (!Array.isArray(blocks)) return blocks;
	for (const block of blocks) {
		if (block?.text?.type === "mrkdwn" && typeof block.text.text === "string") {
			block.text.text = toSlackMrkdwn(block.text.text);
		}
		if (Array.isArray(block?.elements)) {
			for (const el of block.elements) {
				if (el?.type === "mrkdwn" && typeof el.text === "string") {
					el.text = toSlackMrkdwn(el.text);
				}
			}
		}
		if (Array.isArray(block?.fields)) {
			for (const f of block.fields) {
				if (f?.type === "mrkdwn" && typeof f.text === "string") f.text = toSlackMrkdwn(f.text);
			}
		}
	}
	return blocks;
}

// Idempotently patch a WebClient so every chat.postMessage / chat.update
// gets its text and mrkdwn blocks converted. One choke point instead of
// ~20 call sites, and it can't be forgotten at a new one.
function wrapClientFormatting(client) {
	if (!client?.chat || client.__mrkdwnWrapped) return client;
	for (const method of ["postMessage", "update"]) {
		const orig = client.chat[method];
		if (typeof orig !== "function") continue;
		client.chat[method] = function wrapped(args) {
			if (args && typeof args === "object") {
				if (typeof args.text === "string") args.text = toSlackMrkdwn(args.text);
				if (Array.isArray(args.blocks)) convertBlocks(args.blocks);
			}
			return orig.call(this, args);
		};
	}
	// Default terminal-result poster (reply.js). withProgress() overrides
	// this per-dispatch to land in a placeholder; here it's just a post.
	if (typeof client.chat.postResult !== "function") {
		client.chat.postResult = (msg) => client.chat.postMessage(msg);
	}
	client.__mrkdwnWrapped = true;
	return client;
}

module.exports = { toSlackMrkdwn, convertBlocks, wrapClientFormatting };
