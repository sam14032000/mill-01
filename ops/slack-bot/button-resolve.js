"use strict";

// Change 5 (docs/build-prompt-modes.md): a tapped action button must
// visibly resolve. Slack doesn't disable a button on click -- the
// message it lives on has to be edited in place (chat.update) or the
// same button sits there fully tappable forever with no sign anything
// happened. Found live: the weekly profile diff's approve/reject posted
// a *separate* confirmation message and left both buttons rendered and
// tappable on the original.
//
// claimTap()/releaseTap() are the double-tap guard: an in-process Set
// keyed on the message ts. Two taps on the same message racing through
// Bolt handlers -- the second loses claimTap() and is dropped before it
// can run the underlying action twice. A tap arriving after resolution
// also fails claimTap(), because resolveMessage() has already stripped
// the actions block claimTap() checks for.

const resolving = new Set();

function hasActionsBlock(blocks) {
	return Array.isArray(blocks) && blocks.some((b) => b.type === "actions");
}

// Call first, synchronously, before doing anything fallible. Returns
// false if this tap should be ignored (already resolving, or the
// message has already been resolved).
function claimTap(body) {
	const ts = body?.message?.ts;
	if (!ts) return false;
	if (resolving.has(ts)) return false;
	if (!hasActionsBlock(body.message?.blocks)) return false;
	resolving.add(ts);
	return true;
}

// Always call in a `finally` alongside claimTap(), win or lose, so a
// failed update never wedges the guard shut.
function releaseTap(body) {
	const ts = body?.message?.ts;
	if (ts) resolving.delete(ts);
}

// Strips the actions block(s) from the tapped message and appends a
// timestamped outcome line in their place.
async function resolveMessage({ client, body, outcomeText }) {
	const channel = body?.channel?.id;
	const ts = body?.message?.ts;
	if (!channel || !ts) return;
	const blocks = (body.message?.blocks || []).filter((b) => b.type !== "actions");
	blocks.push({
		type: "context",
		elements: [
			{
				type: "mrkdwn",
				text: `${outcomeText} · ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`,
			},
		],
	});
	const text = body.message?.text || outcomeText;
	await client.chat
		.update({ channel, ts, text, blocks })
		.catch((e) => console.error("resolveMessage: chat.update failed:", e?.data?.error || e.message));
}

module.exports = { claimTap, releaseTap, resolveMessage };
