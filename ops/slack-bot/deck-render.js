"use strict";

// The render flow for deck mode: deck.md -> Gamma -> a pptx in the repo.
//
// Explicit, never automatic. A render burns credits (measured: 5 per
// slide), so it happens when the founder asks — not on every deck-mode
// turn, and not on a save.
//
// Three settings, and no more: theme, export format, and image source.
// Slide count and tone are conversational — the persona writes deck.md
// and the number of `---` breaks in it IS the slide count. Language is
// hardcoded `en` (D-35). Per-card layout is Gamma's and cannot be set.
//
// Image source earned its place on the control rather than being a
// constant: Gamma adds imagery whether or not you ask, `aiGenerated`
// bills 2–125 credits PER IMAGE, and the deck persona refuses on audience
// rather than on evidence — so this is the one deck setting with both a
// cost and a fabrication consequence. The option labels name the cost,
// because "AI images" reads as free until it isn't.

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
	return {
		themeId: chat.deck_theme || null,
		exportAs: chat.deck_export || DEFAULT_EXPORT,
		imageSource: chat.deck_images || gamma.DEFAULT_IMAGE_SOURCE,
		textMode: chat.deck_textmode || gamma.DEFAULT_TEXT_MODE,
	};
}

function rememberSettings(id, chatTs, patch) {
	chats.updateChat(id, chatTs, patch);
}

// The in-thread control: three selects and a Render button. Deliberately
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
	// Third control, added deliberately: the image source has real cost and
	// fabrication consequences, so it should be a visible choice rather than
	// a constant buried in code. Labels name the cost, because "AI images"
	// reads as free until it isn't.
	const imgOpt = (v, label) => ({ text: { type: "plain_text", text: label }, value: `${id}::${chatTs}::${v}` });
	// Who authors the deck. Labelled in founder terms, not API terms, and
	// naming the trade -- measured, not guessed: generate keeps the facts
	// and adds marketing register.
	const tmOpt = (v, label) => ({ text: { type: "plain_text", text: label }, value: `${id}::${chatTs}::${v}` });
	const textModes = [
		tmOpt(gamma.TEXT_MODES.preserve, "My words exactly"),
		tmOpt(gamma.TEXT_MODES.generate, "Let Gamma design it (rewrites)"),
	];
	const images = [
		imgOpt(gamma.IMAGE_SOURCES.stock, "Stock photos (free)"),
		imgOpt(gamma.IMAGE_SOURCES.none, "No images"),
		imgOpt(gamma.IMAGE_SOURCES.ai, "AI images (2–125 credits each)"),
	];

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
					{
						type: "static_select",
						action_id: "deck_images",
						placeholder: { type: "plain_text", text: "Images" },
						initial_option: images.find((i) => i.value.endsWith(`::${settings.imageSource}`)) || images[0],
						options: images,
					},
					{
						type: "static_select",
						action_id: "deck_textmode",
						placeholder: { type: "plain_text", text: "Words" },
						initial_option: textModes.find((t) => t.value.endsWith(`::${settings.textMode}`)) || textModes[0],
						options: textModes,
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
	const { themeId, exportAs, imageSource, textMode } = deckSettings(id, chatTs);
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
			imageSource,
			textMode,
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
