"use strict";

// A prototype is a project, not a file — and a touch EDITS it.
//
// What this replaces. `/proto` built its prompt from `[SYSTEM_PROMPT,
// OUTPUT_FORMAT_INSTRUCTION, assumption]` and nothing else, and
// `parseProtoResponse` rejected any filename containing "/". So a
// prototype was one file, regenerated blind, up to five times: touch 2
// was an unrelated generation from the same one-line assumption rather
// than a revision of touch 1. That is the identical blank-page-rewrite
// failure D-57 proved destructive for mode documents — a save over a
// research KB wiped a DGFT trade notice, three competitor names and the
// unit economics — sitting unfixed in proto. No amount of front end
// makes that feel like iteration, because there wasn't any.
//
// These primitives are shared by both engines: the Claude Code path
// (D-58), which edits the tree in place, and the `flash-fast` fallback,
// which returns a whole tree and has it reconciled here. Path
// confinement lives in one place for the same reason the mrkdwn splitter
// does — a guard that each caller has to remember is not a guard.

const fs = require("node:fs");
const path = require("node:path");

// A runaway generation must not fill a 40 GB disk (the same concern
// behind the weekly cron cleanup in CLAUDE.md's pitfalls).
const MAX_FILES = Number(process.env.MILL_PROTO_MAX_FILES) || 40;
const MAX_TOTAL_BYTES = Number(process.env.MILL_PROTO_MAX_BYTES) || 2 * 1024 * 1024;
const MAX_FILE_BYTES = Number(process.env.MILL_PROTO_MAX_FILE_BYTES) || 512 * 1024;

// Files that are ours, not the prototype's — never fed back to the model
// as project content, never counted against the caps.
const META_FILES = new Set(["build-log.md", "output.txt"]);

// THE PATH GUARD.
//
// The old rule was "reject any filename containing a slash", which is
// what forbade subdirectories in the first place. Widening it to allow
// `src/app.js` must not widen it to allow `../../etc/passwd`, so the
// check is positional rather than lexical: resolve the candidate against
// the touch directory and require that it stays inside. `path.resolve`
// collapses `..` first, so `a/../../b` is caught by the same test that
// catches a bare `../b` — no separate rule to keep in sync.
function safeJoin(rootDir, relPath) {
	if (typeof relPath !== "string" || !relPath.trim()) return null;
	const rel = relPath.trim().replace(/^\.\//, "");
	if (path.isAbsolute(rel)) return null;
	if (rel.split(/[\\/]/).some((seg) => seg === ".." || seg === "")) return null;
	// Reject NUL and control characters outright rather than hoping the
	// filesystem does.
	if (/[\u0000-\u001f\u007f]/.test(rel)) return null;
	const root = path.resolve(rootDir);
	const full = path.resolve(root, rel);
	if (full !== root && !full.startsWith(root + path.sep)) return null;
	return full;
}

// Read a touch's tree as { relPath: content }. Used both to feed the
// model the CURRENT state (so it edits rather than invents) and to prove
// in tests that untouched files stayed byte-identical.
function readTree(dir, { includeMeta = false } = {}) {
	const out = {};
	if (!dir || !fs.existsSync(dir)) return out;
	const walk = (abs, rel) => {
		for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			const childAbs = path.join(abs, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === ".git" || entry.name === "node_modules") continue;
				walk(childAbs, childRel);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!includeMeta && META_FILES.has(childRel)) continue;
			out[childRel] = fs.readFileSync(childAbs, "utf8");
		}
	};
	walk(path.resolve(dir), "");
	return out;
}

// Copy the previous touch forward so the next one EDITS it. Meta files
// (build log, captured output) are deliberately left behind: they
// describe the previous attempt, not the project.
function copyTreeForward(fromDir, toDir) {
	fs.mkdirSync(toDir, { recursive: true });
	const tree = readTree(fromDir);
	for (const [rel, content] of Object.entries(tree)) {
		const full = safeJoin(toDir, rel);
		if (!full) continue;
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf8");
	}
	return Object.keys(tree).length;
}

// Parse the fallback engine's multi-file response.
//
// A delimiter, not JSON — the same reasoning as the deck trailer and the
// document sync markers (D-51): escaping whole source files into JSON
// string fields is a reliability problem, and the files are the payload.
//
//   ===FILE: src/app.js===
//   <content>
//   ===FILE: index.html===
//   <content>
//   ===DELETE: old.html===
const FILE_RE = /^===FILE:\s*(.+?)\s*===$/;
const DELETE_RE = /^===DELETE:\s*(.+?)\s*===$/;

function parseTreeResponse(text) {
	const lines = String(text || "").split("\n");
	const files = {};
	const deletes = [];
	let current = null;
	let buf = [];
	const flush = () => {
		if (current !== null) files[current] = buf.join("\n").replace(/\s+$/, "") + "\n";
		current = null;
		buf = [];
	};
	for (const line of lines) {
		const f = line.match(FILE_RE);
		const d = line.match(DELETE_RE);
		if (f) {
			flush();
			current = f[1].trim();
			continue;
		}
		if (d) {
			flush();
			deletes.push(d[1].trim());
			continue;
		}
		if (current !== null) buf.push(line);
	}
	flush();
	if (!Object.keys(files).length && !deletes.length) return null;
	return { files, deletes };
}

// Apply a parsed response to a directory. Returns what actually changed,
// so the founder can be told rather than guessing from a word count.
//
// `existing` is the tree BEFORE the change; anything in it that the
// response does not mention is left exactly as it was. That is the
// whole point: a file the founder did not ask to touch must survive a
// change to a different file.
function applyTree(dir, parsed, { existing = null } = {}) {
	const before = existing || readTree(dir);
	const written = [];
	const removed = [];
	const rejected = [];
	let total = Object.entries(before).reduce((n, [, c]) => n + Buffer.byteLength(c), 0);

	for (const [rel, content] of Object.entries(parsed.files || {})) {
		const full = safeJoin(dir, rel);
		if (!full) {
			rejected.push({ path: rel, why: "escapes the prototype directory" });
			continue;
		}
		if (META_FILES.has(rel)) {
			rejected.push({ path: rel, why: "reserved name" });
			continue;
		}
		const bytes = Buffer.byteLength(content);
		if (bytes > MAX_FILE_BYTES) {
			rejected.push({ path: rel, why: `file over ${Math.round(MAX_FILE_BYTES / 1024)}KB` });
			continue;
		}
		const wasBytes = before[rel] ? Buffer.byteLength(before[rel]) : 0;
		if (total - wasBytes + bytes > MAX_TOTAL_BYTES) {
			rejected.push({ path: rel, why: "project over the total size cap" });
			continue;
		}
		if (!before[rel] && Object.keys(before).length + written.filter((w) => w.added).length >= MAX_FILES) {
			rejected.push({ path: rel, why: `more than ${MAX_FILES} files` });
			continue;
		}
		if (before[rel] === content) continue; // genuinely unchanged
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf8");
		total = total - wasBytes + bytes;
		written.push({ path: rel, added: !before[rel] });
	}

	for (const rel of parsed.deletes || []) {
		const full = safeJoin(dir, rel);
		if (!full || META_FILES.has(rel)) {
			rejected.push({ path: rel, why: "not a deletable project file" });
			continue;
		}
		if (fs.existsSync(full)) {
			fs.rmSync(full, { force: true });
			removed.push(rel);
		}
	}

	const after = readTree(dir);
	const unchanged = Object.keys(before).filter((rel) => after[rel] === before[rel]);
	return { written, removed, rejected, unchanged, fileCount: Object.keys(after).length };
}

// The tree, rendered for a prompt. Capped, because a large project would
// otherwise crowd out the founder's actual request.
function renderTree(tree, { maxBytes = 60_000 } = {}) {
	const names = Object.keys(tree).sort();
	if (!names.length) return "(the project is empty — nothing has been built yet)";
	let out = [`Current project files (${names.length}):`, ""];
	let used = 0;
	for (const rel of names) {
		const body = tree[rel];
		if (used + body.length > maxBytes) {
			out.push(`===FILE: ${rel}===`, `(omitted — the project is large; ask to see this file if you need it)`);
			continue;
		}
		used += body.length;
		out.push(`===FILE: ${rel}===`, body);
	}
	return out.join("\n");
}

module.exports = {
	MAX_FILES,
	MAX_TOTAL_BYTES,
	MAX_FILE_BYTES,
	META_FILES,
	safeJoin,
	readTree,
	copyTreeForward,
	parseTreeResponse,
	applyTree,
	renderTree,
};
