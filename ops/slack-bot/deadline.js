"use strict";

// A hard ceiling on any await, and a breadcrumb trail for the ones that
// hit it.
//
// WHY THIS EXISTS. Three founder-visible hangs in one week, all the same
// shape: a message sat on "_Thinking…_", the process idle at 0.3% CPU
// with no sockets open and not one line in the log. Each diagnosis was
// forensics after the fact — inspecting /proc, counting file descriptors,
// replaying the turn offline — because nothing recorded where the turn
// had got to. The first was a fetch whose abort timer was disarmed when
// the response headers arrived, so a stalled body read waited forever
// (llm.js). The second was the same class one layer out: Slack's
// WebClient ships with no request timeout and a ~30-minute retry budget,
// so a stuck chat.update stranded the turn that had already produced its
// answer.
//
// The lesson is the one D-44 already recorded for the socket and
// CLAUDE.md records for background jobs: for a phone-only system with
// nobody watching logs, "alive but not doing its job" is worse than
// "dead", because only the second one is visible. An await with no
// deadline is exactly that state. So every network wait gets a ceiling,
// and crossing it is loud.
//
// Note what this does NOT do: it cannot cancel the work it is racing.
// Node has no way to abandon an arbitrary promise. The point is that the
// FOUNDER stops waiting and the log records the phase, not that the
// orphaned work is reclaimed.

class DeadlineError extends Error {
	constructor(label, ms) {
		super(`${label} exceeded ${ms}ms`);
		this.name = "DeadlineError";
		this.label = label;
		this.ms = ms;
	}
}

// Races a promise against a timer. Clears the timer either way, so a
// resolved deadline never holds the event loop open.
function withDeadline(promise, ms, label) {
	let timer;
	// Deliberately NOT unref'd. An unref'd timer lets the process exit
	// before the deadline fires, which is precisely the case a watchdog
	// exists for — the awaited work is stuck and holding nothing open.
	// The `.finally` below clears it, so it never keeps the loop alive
	// past the race.
	const guard = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
	});
	return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Same, but a deadline is not an error — it yields `fallback`. For the
// calls whose failure must not take the turn down with it (posting a
// status line, repinning a card).
async function softDeadline(promise, ms, label, fallback = null) {
	try {
		return await withDeadline(promise, ms, label);
	} catch (err) {
		if (err instanceof DeadlineError) {
			console.error(`[deadline] ${label} gave up after ${ms}ms`);
			return fallback;
		}
		throw err;
	}
}

// A per-turn breadcrumb trail. Every phase of a turn logs one line with
// its elapsed time, so the next hang is readable from the log rather
// than reconstructed from /proc. `last()` is what the watchdog reports:
// the phase the turn died in.
function tracer(label) {
	const t0 = Date.now();
	let last = "start";
	return {
		step(phase) {
			last = phase;
			console.log(`[turn ${label}] +${String(Date.now() - t0).padStart(6)}ms ${phase}`);
		},
		last: () => last,
		elapsed: () => Date.now() - t0,
	};
}

module.exports = { withDeadline, softDeadline, tracer, DeadlineError };
