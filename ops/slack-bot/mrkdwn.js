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

// Line-level transforms (headings, bullets) run on WHOLE LINES, before
// inline code is split out.
//
// Found live on the pinned state card: "*Idea `f05e`* · *open*" rendered
// as "*Idea `f05e`• · *open*". eachOutsideInlineCode() fragments a line at
// backticks, so the closing "*" of the bold span began its own segment --
// and the bullet rule, which anchors on ^, treated that SEGMENT start as a
// LINE start and rewrote the "*" to a bullet. A segment boundary is not a
// line boundary.
//
// Doing line-level work first is safe: an inline code span cannot contain
// a newline (the split pattern is `[^`\n]*`), so a real line start is
// never inside one, and the bullet/heading rules only ever rewrite the
// leading marker -- never anything that could sit inside backticks.
function convertLineLevel(seg) {
	return seg
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
}

function convertSegment(seg) {
	// Line-level first, on intact lines.
	const lined = convertLineLevel(seg);
	// Then inline emphasis, with `code` spans protected.
	return eachOutsideInlineCode(lined, (s) => {
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
// Slack rejects a message over 4000 characters with `msg_too_long`. That
// is a REJECTION, not a truncation — and it cost a founder a full reply:
// a product spec was generated, recorded in the session and folded into
// audit-reference.md, and the chat.update that would have shown it was
// rejected into a `.catch(() => {})`. The turn then completed normally,
// so the process went idle with nothing logged and the thread sat on
// "_Thinking…_". Length is not an edge case here: personas write specs.
//
// 3800 leaves room for the mrkdwn conversion above to grow the string.
const SLACK_TEXT_MAX = Number(process.env.MILL_SLACK_TEXT_MAX) || 3800;

// Splits a long message on paragraph, then line, then sentence, then a
// hard cut — the conservative markdown-aware strategy D-39 took from the
// reference bridges. Lives here rather than in promotion.js because the
// choke point is where every outbound message can actually be protected.
function chunkForSlack(text, max = SLACK_TEXT_MAX) {
	if (text.length <= max) return [text];
	const out = [];
	let rest = text;
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n\n", max);
		if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
		if (cut < max * 0.5) cut = rest.lastIndexOf(". ", max);
		if (cut < max * 0.5) cut = max;
		// Don't end a message on a heading whose body is in the next one.
		// A paragraph boundary sits right after a heading line as readily
		// as after a paragraph, and a spec is mostly headings, so this
		// happens constantly: "## Screen 16" alone at the foot of one
		// message and its content at the top of the next.
		let head = rest.slice(0, cut);
		const lastLine = head.slice(head.lastIndexOf("\n") + 1).trim();
		if (/^(#{1,6}\s+\S|\*[^*\n]+\*$)/.test(lastLine) && head.lastIndexOf("\n") > max * 0.3) {
			cut = head.lastIndexOf("\n");
			head = rest.slice(0, cut);
		}
		out.push(head.trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) out.push(rest);
	return out;
}

function wrapClientFormatting(client) {
	if (!client?.chat || client.__mrkdwnWrapped) return client;
	for (const method of ["postMessage", "update"]) {
		const orig = client.chat[method];
		if (typeof orig !== "function") continue;
		client.chat[method] = async function wrapped(args) {
			if (args && typeof args === "object") {
				if (typeof args.text === "string") args.text = toSlackMrkdwn(args.text);
				if (Array.isArray(args.blocks)) convertBlocks(args.blocks);
			}
			const text = args && typeof args.text === "string" ? args.text : null;
			if (text && text.length > SLACK_TEXT_MAX) {
				// With blocks, `text` is only the notification fallback and
				// Slack renders the blocks — trim it rather than splitting a
				// message whose real content lives elsewhere.
				if (Array.isArray(args.blocks) && args.blocks.length) {
					return orig.call(this, { ...args, text: text.slice(0, SLACK_TEXT_MAX) });
				}
				const parts = chunkForSlack(text, SLACK_TEXT_MAX);
				const first = await orig.call(this, { ...args, text: parts[0] });
				// A continuation goes into the same thread. For an update
				// that means threading off the message just edited: Slack
				// resolves a thread_ts pointing at a reply to that reply's
				// parent, so the remainder lands in the founder's thread
				// rather than starting a new one.
				const threadTs = args.thread_ts || (method === "update" ? args.ts : undefined);
				for (const part of parts.slice(1)) {
					await client.chat.postMessage({ channel: args.channel, thread_ts: threadTs, text: part });
				}
				return first;
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

module.exports = { toSlackMrkdwn, convertBlocks, wrapClientFormatting, chunkForSlack, SLACK_TEXT_MAX };
