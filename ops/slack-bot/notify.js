"use strict";

// Minimal Slack post for out-of-band operational alerts (git push/rebase
// failures from git.js's batch loop, etc.) -- deliberately not the Bolt
// `app.client`, so callers that don't have an app handle (git-batch.js's
// setInterval, git.js itself) can still surface a failure to #mill-ideas
// instead of only console.error-ing it where nobody sees it. Same raw
// chat.postMessage shape ops/healthcheck.sh uses.

const https = require("node:https");

function postToMill(text) {
	const token = process.env.SLACK_BOT_TOKEN;
	const channel = process.env.SLACK_CHANNEL_MILL;
	if (!token || !channel) {
		console.error(`notify: SLACK_BOT_TOKEN or SLACK_CHANNEL_MILL unset, dropping alert: ${text}`);
		return Promise.resolve(false);
	}
	const body = JSON.stringify({ channel, text });
	return new Promise((resolve) => {
		const req = https.request(
			{
				method: "POST",
				hostname: "slack.com",
				path: "/api/chat.postMessage",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
				},
			},
			(res) => {
				let buf = "";
				res.on("data", (c) => (buf += c));
				res.on("end", () => {
					try {
						const ok = JSON.parse(buf).ok === true;
						if (!ok) console.error(`notify: Slack rejected the alert: ${buf.slice(0, 200)}`);
						resolve(ok);
					} catch {
						resolve(false);
					}
				});
			},
		);
		req.on("error", (err) => {
			console.error(`notify: alert POST failed: ${err.message}`);
			resolve(false);
		});
		req.write(body);
		req.end();
	});
}

module.exports = { postToMill };
