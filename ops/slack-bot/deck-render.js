"use strict";

// The render flow for deck mode: deck.md -> Gamma -> a pptx in the repo.
//
// Explicit, never automatic. A render burns credits (measured: 5 per
// slide), so it happens when the founder asks — not on every deck-mode
// turn, and not on a save.
//
// Only two settings survive as API parameters, because the from-markdown
// flow takes no others: the theme and the export format. Slide count and
// tone are conversational — the persona writes deck.md and the number of
// `---` breaks in it IS the slide count. Language is hardcoded `en`
// (D-35). Per-card layout is Gamma's to decide and cannot be set.

const fs = require("node:fs");
const path = require("node:path");
const gamma = require("./gamma");
const { readDoc } = require("./mode-docs");
const { IDEAS_DIR, readState } = require("./ideas");
const { commitAndPush } = require("./git");
const { uploadThreadFile } = require("./slack-files");
const chats = require("./chats");

const DEFAULT_EXPORT = "pptx"; // editable is the point of a deck

function deckSettings(id, chatTs) {
	const chat = chats.readChat(id, chatTs) || {};
	return { themeId: chat.deck_theme || null, exportAs: chat.deck_export || DEFAULT_EXPORT };
}

function rememberSettings(id, chatTs, patch) {
	chats.updateChat(id, chatTs, patch);
}

// The in-thread control: two selects and a Render button. Deliberately
// names rather than thumbnails — a grid of 50 theme images in a thread is
// unreadable on a phone. "Browse themes" opens a modal, which Slack
// renders full-screen on mobile, for anyone who wants to see them.
function renderBlocks(id, chatTs, { themes = [], settings }) {
	const themeOptions = themes.slice(0, 100).map((t) => ({
		text: { type: "plain_text", text: t.name.slice(0, 75) },
		value: `${id}::${chatTs}::${t.id}`,
	}));
	const current = settings.themeId && themeOptions.find((o) => o.value.endsWith(`::${settings.themeId}`));
	const exportOpt = (v, label) => ({ text: { type: "plain_text", text: label }, value: `${id}::${chatTs}::${v}` });
	const exports = [exportOpt("pptx", "PowerPoint (editable)"), exportOpt("pdf", "PDF"), exportOpt("png", "Images")];

	const text = "*Render this deck.* Pick a look, or just hit Render — the defaults are fine.";
	return {
		text,
		blocks: [
			{ type: "section", text: { type: "mrkdwn", text } },
			{
				type: "actions",
				block_id: "deck_render",
				elements: [
					{
						type: "static_select",
						action_id: "deck_theme",
						placeholder: { type: "plain_text", text: "Theme" },
						...(current ? { initial_option: current } : {}),
						options: themeOptions.length ? themeOptions : [{ text: { type: "plain_text", text: "default" }, value: `${id}::${chatTs}::default` }],
					},
					{
						type: "static_select",
						action_id: "deck_export",
						placeholder: { type: "plain_text", text: "Format" },
						initial_option: exports.find((e) => e.value.endsWith(`::${settings.exportAs}`)) || exports[0],
						options: exports,
					},
					{ type: "button", action_id: "deck_browse", text: { type: "plain_text", text: "Browse themes" }, value: `${id}::${chatTs}` },
					{ type: "button", action_id: "deck_render_go", style: "primary", text: { type: "plain_text", text: "Render" }, value: `${id}::${chatTs}` },
				],
			},
		],
	};
}

// Full-screen on Slack mobile, a dialog on desktop — the right surface
// for actually SEEING themes, which is the one thing a thread can't do.
function themeModal(id, chatTs, themes) {
	const blocks = [];
	for (const t of themes.slice(0, 30)) {
		blocks.push({
			type: "section",
			text: { type: "mrkdwn", text: `*${t.name}*` },
			accessory: t.thumbnailUrl
				? { type: "image", image_url: t.thumbnailUrl, alt_text: t.name }
				: { type: "button", action_id: `deck_pick_${t.id}`.slice(0, 255), text: { type: "plain_text", text: "Use" }, value: `${id}::${chatTs}::${t.id}` },
		});
		blocks.push({
			type: "actions",
			elements: [{ type: "button", action_id: "deck_pick", text: { type: "plain_text", text: `Use ${t.name}`.slice(0, 75) }, value: `${id}::${chatTs}::${t.id}` }],
		});
	}
	return {
		type: "modal",
		callback_id: "deck_theme_modal",
		title: { type: "plain_text", text: "Deck themes" },
		close: { type: "plain_text", text: "Close" },
		blocks: blocks.length ? blocks : [{ type: "section", text: { type: "mrkdwn", text: "_No themes returned._" }}],
	};
}

// Renders deck.md through Gamma and lands the file in the repo.
async function renderDeck({ id, chatTs, client, channel, progressTs = null }) {
	const deck = readDoc(id, "deck");
	if (!deck || !deck.trim()) {
		return { ok: false, reason: "there's no `deck.md` yet — write the deck in deck mode first" };
	}
	const state = readState(id);
	const { themeId, exportAs } = deckSettings(id, chatTs);
	const slides = gamma.slideCount(deck);

	const say = async (text) => {
		if (progressTs) await client.chat.update({ channel, ts: progressTs, text }).catch(() => {});
		else await client.chat.postMessage({ channel, thread_ts: chatTs, text }).catch(() => {});
	};

	await say(`_Rendering ${slides} slide${slides === 1 ? "" : "s"} through Gamma…_`);

	let generationId;
	try {
		generationId = await gamma.startGeneration({
			inputText: deck,
			themeId,
			exportAs,
			title: `${chats.readChat(id, chatTs)?.title || id} — deck`,
		});
	} catch (err) {
		return { ok: false, reason: err.message };
	}

	const res = await gamma.pollGeneration(generationId, {
		onTick: () => {},
	});
	if (!res.ok) return { ok: false, reason: res.reason };

	// Land the artifact in the repo, so a deck is a committed thing rather
	// than a link that expires with someone's Gamma session.
	let relPath = null;
	try {
		const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
		const dir = path.join(IDEAS_DIR, id, "deck");
		fs.mkdirSync(dir, { recursive: true });
		const ext = exportAs === "png" ? "zip" : exportAs;
		const file = path.join(dir, `${stamp}.${ext}`);
		const buf = Buffer.from(await (await fetch(res.downloadUrl)).arrayBuffer());
		fs.writeFileSync(file, buf);
		relPath = path.relative(path.join(IDEAS_DIR, ".."), file);
		await commitAndPush([relPath], `idea ${id}: rendered deck (${slides} slides, ${res.creditsDeducted} credits)`, (r) =>
			console.error(`deck-render: commit failed: ${r}`),
		);
		await uploadThreadFile(client, { channel, thread_ts: chatTs, filename: path.basename(file), title: "Deck", content: buf }).catch(() => {});
	} catch (err) {
		console.error(`deck-render: could not store the export: ${err.message}`);
	}

	const lines = [
		`📊 *Deck rendered* — ${slides} slide${slides === 1 ? "" : "s"}.`,
		`<${res.editUrl}|Open in Gamma to review or refine>`,
		relPath ? `Committed to \`${relPath}\`.` : "_Couldn't store the file — the Gamma link above still works._",
		`_${res.creditsDeducted} credits used, ${res.creditsRemaining} left this month._`,
	];
	await say(lines.join("\n"));
	return { ok: true, ...res, slides, relPath };
}

module.exports = { renderBlocks, themeModal, renderDeck, deckSettings, rememberSettings };
