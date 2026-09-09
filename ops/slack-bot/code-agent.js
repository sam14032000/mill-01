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
// A plan READS and reasons; it never writes. It does not need a build's
// headroom, and every extra turn re-sends the whole brief plus the
// transcript so far — which is where the cost compounds.
const MAX_TURNS_PLAN = Number(process.env.MILL_PROTO_MAX_TURNS_PLAN) || 6;
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

function baseArgs({ cwd, model, effort, maxTurns = MAX_TURNS }) {
	return [
		"-p",
		"--output-format", "json",
		"--restricted",
		"--bare",
		"--model", model,
		"--effort", EFFORTS.includes(effort) ? effort : DEFAULT_EFFORT,
		"--max-turns", String(maxTurns),
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


// PRE-FLIGHT BUDGET CHECK.
//
// A founder approved a plan, tapped Build, and the build died mid-flight
// on "Budget has been exceeded" — losing the plan they had just read and
// agreed to. The daily cap is the right guard (D-23: provider caps are
// the last line), but hitting it AFTER the expensive part is the worst
// place to find out.
//
// So: ask what's left before spawning. Deliberately FAILS OPEN — if the
// proxy can't be reached the real cap still protects, and a monitoring
// hiccup must not block a founder's build.
const EST_PLAN_USD = Number(process.env.MILL_PROTO_EST_PLAN_USD) || 0.3;
const EST_BUILD_USD = Number(process.env.MILL_PROTO_EST_BUILD_USD) || 0.7;

async function budgetRemaining(apiKey) {
	try {
		const r = await fetch(`${BASE_URL}/key/info`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(8000),
		});
		if (!r.ok) return null;
		const info = (await r.json())?.info || {};
		if (typeof info.max_budget !== "number") return null;
		const spend = Number(info.spend || 0);
		return { spend, max: info.max_budget, remaining: info.max_budget - spend, resetAt: info.budget_reset_at || null };
	} catch {
		return null;
	}
}

function budgetRefusal(b, need, label) {
	const resets = b.resetAt ? ` It resets at ${String(b.resetAt).slice(11, 16)} UTC.` : "";
	// "$-0.17 left" is arithmetic, not English. Over the cap is a different
	// sentence from nearly at it.
	const left =
		b.remaining <= 0
			? `Today's $${b.max.toFixed(2)} coding budget is used up`
			: `Only $${b.remaining.toFixed(2)} left of today's $${b.max.toFixed(2)} coding budget`;
	// A refused BUILD leaves an approved plan waiting; a refused PLAN
	// leaves nothing to reassure the founder about.
	const tail = label === "build" ? " Nothing was spent, and your approved plan is still here." : " Nothing was spent.";
	return {
		ok: false,
		budget: true,
		remaining: b.remaining,
		reason: `${left}, and a ${label} usually costs about $${need.toFixed(2)}, so I haven't started one.${resets}${tail}`,
	};
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
	const pre = preflight(apiKey);
	if (pre) return { ...pre, sessionId: sessionId || null };
	const budget = await budgetRemaining(apiKey);
	if (budget && budget.remaining < EST_PLAN_USD) return budgetRefusal(budget, EST_PLAN_USD, "plan");
	const sid = sessionId || newSessionId();
	const build = (asResume) => {
		const a = [
			...baseArgs({ cwd, model: PLAN_MODEL, effort, maxTurns: MAX_TURNS_PLAN }),
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
async function build({ cwd, sessionId, request = "Implement the plan you just described.", brief = "", effort = DEFAULT_EFFORT, apiKey = process.env.MILL_CODE_KEY }) {
	const pre = preflight(apiKey);
	if (pre) return pre;
	if (!sessionId) return { ok: false, reason: "no session to resume" };
	// Checked BEFORE the build, so an approved plan is never burned by a
	// cap the founder could have seen coming.
	const budget = await budgetRemaining(apiKey);
	if (budget && budget.remaining < EST_BUILD_USD) return budgetRefusal(budget, EST_BUILD_USD, "build");
	const args = [
		...baseArgs({ cwd, model: BUILD_MODEL, effort }),
		"--permission-mode", "acceptEdits",
		"--resume", sessionId,
		"--max-budget-usd", String(MAX_USD_BUILD),
	];
	// A resumed session carries the conversation but NOT the system
	// prompt, so the specs go on every call or the build works from
	// whatever the conversation happens to still contain.
	if (brief) args.push("--append-system-prompt", brief);

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
let availableCache = null;
function available() {
	if (!process.env.MILL_CODE_KEY) return false;
	if (availableCache !== null) return availableCache;
	try {
		require("node:child_process").execFileSync(BIN, ["--version"], { stdio: "ignore", timeout: 15_000 });
		availableCache = true;
	} catch {
		availableCache = false;
	}
	return availableCache;
}
// Tests flip MILL_CLAUDE_BIN between runs.
function resetAvailableCache() {
	availableCache = null;
}

// The binary check comes BEFORE the budget check, and the order matters.
// A missing binary must report `missing` so the caller can fall back to
// the flash-fast path — which bills a DIFFERENT key with its own budget.
// Checking budget first would refuse on a cap that has nothing to do with
// the fallback, and the founder would get nothing at all.
function preflight(apiKey, need, label) {
	if (!apiKey) return { ok: false, reason: "MILL_CODE_KEY not set" };
	if (!available()) return { ok: false, missing: true, reason: `${BIN} is not available on this box` };
	return null;
}

module.exports = {
	plan,
	budgetRemaining,
	build,
	available,
	resetAvailableCache,
	newSessionId,
	childEnv,
	baseArgs,
	PLAN_SCHEMA,
	PLAN_MODEL,
	BUILD_MODEL,
	EFFORTS,
	DEFAULT_EFFORT,
};
