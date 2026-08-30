"use strict";

// Upload a text file to a Slack thread (files.uploadV2). Best-effort:
// the bot token needs the `files:write` scope. Without it uploadV2
// returns `missing_scope` -- we log it once and carry on, because the
// caller has already told the founder where the file lives in the repo.
// (Surface-search reports, D-53: the report is stored in the project
// either way; the attachment is a convenience.)

let scopeWarned = false;

async function uploadThreadFile(client, { channel, thread_ts = undefined, filename, title = undefined, content, initial_comment = undefined }) {
	if (typeof client?.files?.uploadV2 !== "function") return { ok: false, reason: "no_uploadV2" };
	try {
		await client.files.uploadV2({
			channel_id: channel,
			...(thread_ts ? { thread_ts } : {}),
			filename,
			...(title ? { title } : {}),
			...(initial_comment ? { initial_comment } : {}),
			content,
		});
		return { ok: true };
	} catch (err) {
		const code = err?.data?.error || err?.message || String(err);
		if (/missing_scope|not_allowed_token_type/.test(code)) {
			if (!scopeWarned) {
				console.error("slack-files: files.uploadV2 needs the `files:write` scope — report saved to the repo, not attached. Add the scope to enable attachments.");
				scopeWarned = true;
			}
			return { ok: false, reason: "missing_scope" };
		}
		console.error(`slack-files: upload failed (${filename}): ${code}`);
		return { ok: false, reason: code };
	}
}

module.exports = { uploadThreadFile };
