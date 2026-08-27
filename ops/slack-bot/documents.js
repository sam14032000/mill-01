"use strict";

// Document capture + indexing for project channels (build-guide-projects
// Part 17, docs/PROJECTS.md "Documents"). Handled off the `message`
// event's `file_share` subtype (which arrives on the already-subscribed
// message.channels event) rather than a separate `file_shared`
// subscription.

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const { callFlash } = require("./llm");
const { findIdeaByChannel } = require("./ideas");
const { commitAndPush } = require("./git");
const { ensureStageThread } = require("./chat-session");
const { emit } = require("./telemetry");
const { buildEvalEvent } = require("./eval-event");
const { founderForUserId } = require("./config");

const IDEAS_DIR = path.resolve(__dirname, "..", "..", "ideas");
const MB = 1024 * 1024;
const ACCEPT_LIMIT = 5 * MB;
const REFUSE_LIMIT = 20 * MB;

// Extensions we can turn into text ourselves. Everything else is stored
// raw with the index entry marked "extraction failed" (17.3 / verify).
const PASSTHROUGH_TEXT = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".log", ".rtf"]);
const GEMINI_NATIVE = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MIME_BY_EXT = {
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

function download(url) {
	return new Promise((resolve, reject) => {
		const req = https.get(
			url,
			{ headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, timeout: 30_000 },
			(res) => {
				if (res.statusCode !== 200) {
					reject(new Error(`download HTTP ${res.statusCode}`));
					return;
				}
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve(Buffer.concat(chunks)));
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error("download timed out")));
	});
}

// Overridable so tests can supply file bytes (or a forced failure)
// without a live Slack URL. Production always uses the real `download`.
let _downloader = download;
function _setDownloader(fn) {
	_downloader = fn || download;
}

async function downloadWithRetry(url) {
	try {
		return await _downloader(url);
	} catch (err) {
		console.error(`documents: first download attempt failed (${err.message}), retrying once`);
		return _downloader(url);
	}
}

// Never overwrite (17.1): collision -> name-2.ext, name-3.ext, ...
function collisionFreePath(dir, filename) {
	const ext = path.extname(filename);
	const base = path.basename(filename, ext);
	let candidate = path.join(dir, filename);
	let n = 2;
	while (fs.existsSync(candidate)) {
		candidate = path.join(dir, `${base}-${n}${ext}`);
		n += 1;
	}
	return candidate;
}

async function extractText(buf, ext, storedName) {
	if (PASSTHROUGH_TEXT.has(ext)) {
		return { text: buf.toString("utf8").slice(0, 200_000), ok: true };
	}
	if (GEMINI_NATIVE.has(ext)) {
		// Gemini 3.x accepts inline file data via an OpenAI-style
		// image_url data URI through LiteLLM. If this route or the model
		// rejects it, we fall through to "extraction failed" -- the raw
		// file is still stored either way.
		const dataUri = `data:${MIME_BY_EXT[ext]};base64,${buf.toString("base64")}`;
		const { content } = await callFlash(
			[
				{
					role: "user",
					content: [
						{ type: "text", text: `Extract the readable text and key figures from ${storedName}. Return plain text only.` },
						{ type: "image_url", image_url: { url: dataUri } },
					],
				},
			],
			{ model: "flash-fast", maxTokens: 4096 },
		);
		return { text: (content || "").slice(0, 200_000), ok: Boolean(content && content.trim()) };
	}
	// .docx / .xlsx / others -- no converter on the box.
	return { text: "", ok: false };
}

const INDEX_PROMPT = [
	"Write a documents-index entry for this file. Output exactly:",
	"Type: <one short phrase>",
	"Summary: <~150 words>",
	"Key figures:",
	"- <number-bearing bullet>  (3 to 5 of these, numbers only, no prose)",
	"If the provided text is empty or unusable, still output the Type line as 'unknown' and Summary as 'extraction failed — raw file stored, not indexed'.",
].join("\n");

async function buildIndexEntry({ storedName, uploader, sizeBytes, ext, extracted }) {
	const dateStr = new Date().toISOString().slice(0, 10);
	const sizeMb = (sizeBytes / MB).toFixed(2);
	let body;
	if (!extracted.ok || !extracted.text.trim()) {
		body = "Type: unknown\nSummary: extraction failed — raw file stored, not indexed.\nKey figures:\n- (none)";
	} else {
		try {
			const { content } = await callFlash(
				[
					{ role: "system", content: INDEX_PROMPT },
					{ role: "user", content: extracted.text.slice(0, 60_000) },
				],
				{ model: "flash-fast", maxTokens: 1024 },
			);
			body = (content || "").trim() || "Type: unknown\nSummary: (index model returned nothing).\nKey figures:\n- (none)";
		} catch (err) {
			console.error(`documents: index model call failed: ${err.message}`);
			body = "Type: unknown\nSummary: extraction failed — raw file stored, not indexed.\nKey figures:\n- (none)";
		}
	}
	return `## ${storedName}\nuploaded by ${uploader} · ${dateStr} · ${sizeMb} MB\n${body}\n`;
}

// Entry point from index.js's message router. `message` is a
// subtype:"file_share" message in a project channel. Returns true if
// consumed.
async function handleProjectUpload({ message, client }) {
	if (message.subtype !== "file_share") return false;
	if (!message.files || !message.files.length) return false;
	const project = findIdeaByChannel(message.channel);
	if (!project) return false; // 17: project channels only

	const uploader = founderForUserId(message.user) || "unknown";
	const dest = { project, channel: message.channel, stage: "documents", threadTs: project.threads?.documents };
	await ensureStageThread(client, dest);
	const reply = (text) =>
		client.chat
			.postMessage({ channel: message.channel, thread_ts: dest.threadTs, text })
			.catch(() => {});

	const docsDir = path.join(IDEAS_DIR, project.id, "docs");
	fs.mkdirSync(docsDir, { recursive: true });
	let handled = 0;

	for (const f of message.files) {
		const name = f.name || `${f.id}`;
		const ext = path.extname(name).toLowerCase();
		const size = f.size || 0;

		if (size > REFUSE_LIMIT) {
			await reply(`📎 *${name}* is ${(size / MB).toFixed(1)} MB — over the 20 MB limit. Git keeps every version forever on a 40 GB disk. Upload an extract or the key pages instead.`);
			emit(buildEvalEvent({ stage: "document", founder: uploader, ideaId: project.id, status: "refused", reasonCode: "too_large" }));
			continue;
		}

		let buf;
		try {
			buf = await downloadWithRetry(f.url_private);
		} catch (err) {
			await reply(`📎 Couldn't download *${name}* from Slack (${err.message}). It is **not** stored — re-upload it. (Slack files expire on the free plan, so this can't be retried later.)`);
			emit(buildEvalEvent({ stage: "document", founder: uploader, ideaId: project.id, status: "failed", reasonCode: "download_failed" }));
			continue;
		}

		const storedPath = collisionFreePath(docsDir, name);
		const storedName = path.basename(storedPath);
		fs.writeFileSync(storedPath, buf);

		let extracted = { text: "", ok: false };
		try {
			extracted = await extractText(buf, ext, storedName);
		} catch (err) {
			console.error(`documents: extraction threw for ${storedName}: ${err.message}`);
		}

		const entry = await buildIndexEntry({ storedName, uploader, sizeBytes: buf.length, ext, extracted });
		fs.appendFileSync(path.join(docsDir, "index.md"), `\n${entry}`);

		await commitAndPush(
			[`ideas/${project.id}/docs`],
			`idea ${project.id}: document ${storedName} uploaded by ${uploader}`,
			(r) => console.error(`documents: commit/push failed: ${r}`),
		);

		const warn =
			size > ACCEPT_LIMIT
				? `\n⚠️ ${(size / MB).toFixed(1)} MB — large; every re-upload bloats the repo. Prefer extracts.`
				: "";
		const idx = extracted.ok
			? "Indexed. Brainstorm sees the index by default; `@" + storedName + "` in a `/think` pulls the full text."
			: "*Extraction failed* (no converter for this type) — raw file stored, index entry marked so.";
		await reply(`📎 Stored *${storedName}* in \`ideas/${project.id}/docs/\`. ${idx}${warn}`);

		try {
			await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: "white_check_mark" });
		} catch {
			/* reaction is best-effort */
		}

		emit(
			buildEvalEvent({
				stage: "document",
				founder: uploader,
				ideaId: project.id,
				status: "ok",
				reasonCode: extracted.ok ? "indexed" : "extraction_failed",
			}),
		);
		handled += 1;
	}

	return handled > 0 || message.files.length > 0;
}

module.exports = { handleProjectUpload, collisionFreePath, extractText, ACCEPT_LIMIT, REFUSE_LIMIT, _setDownloader };
