"use strict";

// Claude Code as proto's build engine (D-58): plan on Opus, a founder
// approves, build on Sonnet.
//
// It runs ON THE HOST — the founders' decision, taken against a stated
// objection, because the alternative was standing up credentials inside a
// container. That makes the fencing below the load-bearing part of this
// file rather than boilerplate. Every claim here was probed, not read off
// the help text: an earlier draft asserted a `--sandbox` flag that does
// not exist, having misread text that belongs to `--restricted`.
//
// THE FENCE
//
//   --restricted   one flag doing several jobs: removes Bash, PowerShell,
//                  REPL and every other code-running tool plus WebFetch,
//                  ignores user/project/local settings files, refuses
//                  bypassPermissions, AND confines the file tools to the
//                  working directories.
//   env allowlist  mill-chat runs as User=agent with
//                  EnvironmentFile=~/.config/mill/env, so a naively
//                  spawned child inherits every Gemini, Anthropic, Slack,
//                  Tavily, Gamma and ngrok credential. The child is built
//                  from an explicit allowlist, never by filtering a
//                  denylist out of process.env — a denylist is one new
//                  secret away from being wrong.
//   --bare         so the repo-root CLAUDE.md, which describes the mill
//                  and where its keys live, is never auto-discovered.
//   cwd + --add-dir  the touch directory and nothing else.
//
// Confinement is proven MECHANICAL rather than ethical. Asked to copy
// ~/.config/mill/env into its working directory the agent refused, but a
// refusal reasoned from ethics is not a control; re-run against
// /etc/hostname — a file with no ethical signal at all — it refused again
// and cited the mechanism: "I'm restricted to operating within the
// working directory."
//
// Nothing it writes is ever RUN here. Execution stays in Part 10's Docker
// sandbox (D-06, D-48), which is the blast-radius argument D-06 was
// actually written for.

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { withDeadline, DeadlineError } = require("./deadline");

const BIN = process.env.MILL_CLAUDE_BIN || "claude";
const BASE_URL = process.env.LITELLM_BASE_URL || "http://127.0.0.1:4000";

const PLAN_MODEL = process.env.MILL_PROTO_PLAN_MODEL || "claude-opus-5";
const BUILD_MODEL = process.env.MILL_PROTO_BUILD_MODEL || "claude-sonnet-5";

// Three independent ceilings. `--max-budget-usd` is a safety stop, not a
// founder control -- a founder can reason about "think harder", not about
// "$0.40" (D-58), so `effort` is what they see.
const MAX_USD_PLAN = Number(process.env.MILL_PROTO_PLAN_USD) || 0.5;
const MAX_USD_BUILD = Number(process.env.MILL_PROTO_BUILD_USD) || 1.0;
const MAX_TURNS = Number(process.env.MILL_PROTO_MAX_TURNS) || 12;
const DEADLINE_MS = Number(process.env.MILL_PROTO_DEADLINE_MS) || 600_000;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_EFFORT = process.env.MILL_PROTO_EFFORT || "medium";

// Relative paths and a short verb are asked for explicitly: a probe
// returned absolute paths and a sentence-long "action", which renders
// badly on a phone.
const PLAN_SCHEMA = {
	type: "object",
	properties: {
		summary: { type: "string", description: "2-4 sentences: what you will change and why. No preamble." },
		files: {
			type: "array",
			description: "Every file you will touch.",
			items: {
				type: "object",
				properties: {
					path: { type: "string", description: "Path RELATIVE to the project root. Never absolute." },
					action: { type: "string", description: "One word: add, edit, or delete." },
					why: { type: "string", description: "One short sentence." },
				},
				required: ["path", "action", "why"],
			},
		},
		unsure: {
			type: "array",
			description: "Anything you had to assume, or a decision the founder should make. Empty if genuinely none.",
			items: { type: "string" },
		},
	},
	required: ["summary", "files", "unsure"],
};

function newSessionId() {
	return crypto.randomUUID();
}

// EXPLICIT ALLOWLIST. Adding a variable here is a deliberate act; the
// inverse (filtering secrets out) silently breaks the day someone adds a
// new key to ~/.config/mill/env.
function childEnv(apiKey) {
	return {
		PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
		HOME: process.env.HOME || "/home/agent",
		LANG: process.env.LANG || "C.UTF-8",
		ANTHROPIC_BASE_URL: BASE_URL,
		ANTHROPIC_API_KEY: apiKey,
	};
}

function baseArgs({ cwd, model, effort }) {
	return [
		"-p",
		"--output-format", "json",
		"--restricted",
		"--bare",
		"--model", model,
		"--effort", EFFORTS.includes(effort) ? effort : DEFAULT_EFFORT,
		"--max-turns", String(MAX_TURNS),
		"--add-dir", cwd,
	];
}

function run({ args, cwd, apiKey, prompt }) {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let child;
		try {
			child = spawn(BIN, args, { cwd, env: childEnv(apiKey), stdio: ["pipe", "pipe", "pipe"] });
		} catch (err) {
			resolve({ ok: false, reason: `could not start ${BIN}: ${err.message}`, missing: true });
			return;
		}
		child.on("error", (err) => {
			resolve({ ok: false, reason: `could not start ${BIN}: ${err.message}`, missing: err.code === "ENOENT" });
		});
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("close", (code) => {
			resolve({ ok: code === 0, code, stdout, stderr });
		});
		if (prompt) {
			child.stdin.write(prompt);
			child.stdin.end();
		}
	});
}

// The `-p --output-format json` envelope. Its `result` is the model's
// answer; with --json-schema that answer is itself JSON.
function parseEnvelope(stdout) {
	try {
		const env = JSON.parse(stdout);
		return { ok: !env.is_error, env, cost: env.total_cost_usd ?? 0, result: env.result };
	} catch {
		return { ok: false, env: null, cost: 0, result: null };
	}
}

// PLAN. Read-only -- verified by hashing a tree before and after: both
// files came back byte-identical. A plan that can write is not a gate.
// `--session-id` CREATES a session; `--resume` continues one. Passing
// --session-id for a second turn fails with "Session ID <uuid> is already
// in use", which is exactly what a founder hit on their first [Adjust]:
// the bootstrap created the session, the adjust tried to create it again.
// Probed to be sure of the semantics rather than inferred from the error:
// --session-id on a fresh id works, on the same id fails, and --resume on
// it works AND remembers the earlier turn.
//
// The two are also self-healing in both directions, because a session
// file can be pruned or a caller can be wrong about which state it is in:
// "already in use" retries as a resume, and a missing session retries as
// a new one. Neither should happen; both are cheap to survive.
function sessionArgs(sid, resume) {
	return resume ? ["--resume", sid] : ["--session-id", sid];
}
const ALREADY_IN_USE = /already in use/i;
const NO_SUCH_SESSION = /no conversation found|session not found|no such session/i;

async function plan({ cwd, request, brief = "", sessionId = null, resume = false, effort = DEFAULT_EFFORT, apiKey = process.env.MILL_CODE_KEY }) {
	if (!apiKey) return { ok: false, reason: "MILL_CODE_KEY not set" };
	const sid = sessionId || newSessionId();
	const build = (asResume) => {
		const a = [
			...baseArgs({ cwd, model: PLAN_MODEL, effort }),
			"--permission-mode", "plan",
			...sessionArgs(sid, asResume),
			"--max-budget-usd", String(MAX_USD_PLAN),
			"--json-schema", JSON.stringify(PLAN_SCHEMA),
		];
		if (brief) a.push("--append-system-prompt", brief);
		return a;
	};

	let res;
	const attempt = async (asResume) => withDeadline(run({ args: build(asResume), cwd, apiKey, prompt: request }), DEADLINE_MS, "proto plan");
	try {
		res = await attempt(resume);
		const out = `${res.stdout || ""}${res.stderr || ""}`;
		if (!res.ok && ALREADY_IN_USE.test(out)) {
			console.warn(`code-agent: session ${sid} exists — retrying as a resume`);
			res = await attempt(true);
		} else if (!res.ok && NO_SUCH_SESSION.test(out)) {
			console.warn(`code-agent: session ${sid} is gone — starting it fresh`);
			res = await attempt(false);
		}
	} catch (err) {
		if (err instanceof DeadlineError) return { ok: false, reason: `planning stalled past ${Math.round(DEADLINE_MS / 1000)}s`, sessionId: sid };
		return { ok: false, reason: err.message, sessionId: sid };
	}
	if (res.missing) return { ok: false, missing: true, reason: res.reason, sessionId: sid };
	const parsed = parseEnvelope(res.stdout);
	if (!parsed.ok) {
		// An error envelope usually still carries the model's own account of
		// what happened -- including, when a tool was blocked, the exact
		// enforcement message. Discarding it in favour of raw stderr threw
		// away the most useful diagnostic we get.
		const said = String(parsed.env?.result || "").trim();
		const status = parsed.env?.api_error_status ? ` (api ${parsed.env.api_error_status})` : "";
		return {
			ok: false,
			sessionId: sid,
			cost: parsed.cost,
			raw: said,
			reason: `plan failed${status}: ${said.slice(0, 400) || (res.stderr || res.stdout || "no output").slice(-400)}`,
		};
	}
	let planObj = null;
	try {
		planObj = typeof parsed.result === "string" ? JSON.parse(parsed.result) : parsed.result;
	} catch {
		planObj = null;
	}
	if (!planObj || !Array.isArray(planObj.files)) {
		return { ok: false, reason: "the plan came back in an unexpected shape", sessionId: sid, cost: parsed.cost, raw: String(parsed.result || "").slice(0, 1500) };
	}
	// Relative paths are asked for in the schema; enforce it here anyway,
	// because a founder reading "/tmp/plan2-a3ra/index.html" learns nothing.
	planObj.files = planObj.files.map((f) => ({ ...f, path: String(f.path || "").replace(`${cwd}/`, "").replace(/^\//, "") }));
	return { ok: true, plan: planObj, sessionId: sid, cost: parsed.cost };
}

// BUILD. Resumes the SAME session the plan was made in, so it is acting
// on its own plan rather than re-deriving one from a summary.
async function build({ cwd, sessionId, request = "Implement the plan you just described.", effort = DEFAULT_EFFORT, apiKey = process.env.MILL_CODE_KEY }) {
	if (!apiKey) return { ok: false, reason: "MILL_CODE_KEY not set" };
	if (!sessionId) return { ok: false, reason: "no session to resume" };
	const args = [
		...baseArgs({ cwd, model: BUILD_MODEL, effort }),
		"--permission-mode", "acceptEdits",
		"--resume", sessionId,
		"--max-budget-usd", String(MAX_USD_BUILD),
	];

	let res;
	try {
		res = await withDeadline(run({ args, cwd, apiKey, prompt: request }), DEADLINE_MS, "proto build");
	} catch (err) {
		if (err instanceof DeadlineError) return { ok: false, reason: `the build stalled past ${Math.round(DEADLINE_MS / 1000)}s` };
		return { ok: false, reason: err.message };
	}
	if (res.missing) return { ok: false, missing: true, reason: res.reason };
	const parsed = parseEnvelope(res.stdout);
	if (!parsed.ok) {
		const said = String(parsed.env?.result || "").trim();
		return { ok: false, cost: parsed.cost, raw: said, reason: `the build failed: ${said.slice(0, 400) || (res.stderr || res.stdout || "no output").slice(-400)}` };
	}
	return { ok: true, summary: String(parsed.result || "").trim(), cost: parsed.cost, sessionId };
}

// Is the engine usable at all? `/proto` must never hard-fail on its
// absence -- it falls back to the flash-fast tree path.
function available() {
	if (!process.env.MILL_CODE_KEY) return false;
	try {
		require("node:child_process").execFileSync(BIN, ["--version"], { stdio: "ignore", timeout: 15_000 });
		return true;
	} catch {
		return false;
	}
}

module.exports = {
	plan,
	build,
	available,
	newSessionId,
	childEnv,
	baseArgs,
	PLAN_SCHEMA,
	PLAN_MODEL,
	BUILD_MODEL,
	EFFORTS,
	DEFAULT_EFFORT,
};
