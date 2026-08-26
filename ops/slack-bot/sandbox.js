"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");

const RUN_SH = path.join(os.homedir(), "stack", "sandbox", "run.sh");
const DEFAULT_TIMEOUT_MS = 30_000;

// D-06 / D-29: this is the ONLY function in the codebase that executes
// generated content. Every other command only ever calls a model or
// writes files directly. Always goes through Part 10's run.sh -- never
// a raw `docker run`, never anything on the host -- so the sandbox's
// security configuration (network isolation, no host mount beyond
// scratch, capability drops) lives in exactly one place and can't drift
// between a "real" path and a shortcut.
function runInSandbox({ scratchDir, command, network = "none", timeoutMs = DEFAULT_TIMEOUT_MS }) {
	return new Promise((resolve) => {
		execFile(
			RUN_SH,
			[command],
			{
				env: {
					...process.env,
					MILL_SANDBOX_SCRATCH_DIR: scratchDir,
					MILL_SANDBOX_NETWORK: network,
				},
				timeout: timeoutMs,
				maxBuffer: 1024 * 1024,
			},
			(error, stdout, stderr) => {
				resolve({
					ok: !error,
					timedOut: error?.killed === true,
					stdout,
					stderr,
					error: error && !error.killed ? String(error.message || error) : null,
				});
			},
		);
	});
}

module.exports = { runInSandbox, RUN_SH };
