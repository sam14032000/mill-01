"use strict";

// D-40: identity comes only from Slack's verified user_id against this
// static map. No passphrase, no secondary login. Anything off the map
// is not a founder as far as this bot is concerned.
const raw = {
	[process.env.FOUNDER_SAKSHAM]: "saksham",
	[process.env.FOUNDER_AMISHA]: "amisha",
	[process.env.FOUNDER_VAIBHAV]: "vaibhav",
};
delete raw.undefined; // an unset env var makes the key literally "undefined"
const ALLOWLIST = Object.freeze(raw);

function founderForUserId(userId) {
	return ALLOWLIST[userId] || null;
}

module.exports = { founderForUserId };
