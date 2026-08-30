"use strict";

// Change 3 (docs/build-prompt-modes.md): tracks the exact input-document
// snapshot a mode's document was generated/regenerated against, so a
// later change can be diffed against what was actually seen -- not
// re-derived or assumed. One file per idea, `.doc-meta.json`, leading
// dot so it reads as bookkeeping, not a founder-facing document.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { IDEAS_DIR } = require("./ideas");

function metaPath(id) {
	return path.join(IDEAS_DIR, id, ".doc-meta.json");
}

function readMeta(id) {
	const p = metaPath(id);
	if (!fs.existsSync(p)) return {};
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return {};
	}
}

function writeMeta(id, patch) {
	const cur = readMeta(id);
	const next = { ...cur, ...patch };
	fs.mkdirSync(path.dirname(metaPath(id)), { recursive: true });
	fs.writeFileSync(metaPath(id), `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return next;
}

function hashOf(content) {
	return crypto.createHash("sha256").update(content || "").digest("hex");
}

// Called every time a mode's document is generated or regenerated:
// records what its input document looked like at that moment.
function recordGeneration(id, mode, inputContent) {
	writeMeta(id, {
		[mode]: {
			inputHash: hashOf(inputContent),
			inputSnapshot: inputContent || null,
			generatedAt: new Date().toISOString(),
		},
	});
}

function generationRecord(id, mode) {
	return readMeta(id)[mode] || null;
}

module.exports = { readMeta, writeMeta, hashOf, recordGeneration, generationRecord, metaPath };
