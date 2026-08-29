"use strict";

// Part 18.2 / PROJECTS.md: `/spinoff <new idea>` from inside a project
// creates a child project and records lineage both ways. From a chat
// there is no spinoff -- just start another chat.

const { founderForUserId, channelId } = require("../config");
const { generateIdeaId, promoteIdea, readState, updateState } = require("../ideas");
const { commitAndPush } = require("../git");
const { commandDestination, ensureStageThread } = require("../chat-session");
const { createProjectChannel } = require("../project-channel");
const { upsertStateCard } = require("../state-card");
const { emit } = require("../telemetry");
const { buildEvalEvent } = require("../eval-event");

async function handleSpinoffCommand({ command, ack, client }) {
	const founder = founderForUserId(command.user_id);
	if (!founder) {
		await ack();
		return;
	}

	const pdest = commandDestination(command);
	if (!pdest.project) {
		await ack({
			response_type: "ephemeral",
			text: "`/spinoff` only works inside a project channel. From a chat, just start another `/chat`.",
		});
		return;
	}
	const ideaText = (command.text || "").trim();
	if (!ideaText) {
		await ack({ response_type: "ephemeral", text: "`/spinoff <the new idea>`" });
		return;
	}

	await ack();
	const parent = pdest.project;
	const millChannel = channelId("mill");
	const id = generateIdeaId();

	let child;
	try {
		child = await createProjectChannel({ id, sourceText: ideaText, assumption: null, client });
	} catch (err) {
		await client.chat
			.postMessage({ channel: parent.channel_id, thread_ts: parent.threads?.brainstorm, text: `\`/spinoff\` failed: couldn't create the child channel (${err?.data?.error || err.message}). Nothing created.` })
			.catch(() => {});
		return;
	}

	promoteIdea({
		id,
		founder,
		topic: ideaText,
		assumption: null,
		originChatMd: `Spun off from \`${parent.id}\` by ${founder} on ${new Date().toISOString().slice(0, 10)}.\n\nParent idea: see \`ideas/${parent.id}/\`.\n\n> ${ideaText}\n`,
		originChatTs: null,
		summary: `Spun off from \`${parent.id}\`. ${ideaText}`,
		channelId: child.channelId,
		threads: child.threads,
	});
	// lineage both ways (PROJECTS.md)
	updateState(id, { parent: parent.id });
	const parentState = readState(parent.id) || {};
	updateState(parent.id, { children: [...(parentState.children || []), id] });

	await commitAndPush(
		[`ideas/${id}`, `ideas/${parent.id}/state.json`],
		`idea ${id}: spun off from ${parent.id} by ${founder}`,
		(r) => console.error(`spinoff commit/push failed: ${r}`),
	);

	await ensureStageThread(client, pdest);
	await client.chat
		.postMessage({ channel: parent.channel_id, thread_ts: pdest.threadTs, text: `🌱 Spun off <#${child.channelId}> (\`${id}\`) — ${ideaText}` })
		.catch(() => {});
	const childSeed = await client.chat
		.postMessage({ channel: child.channelId, thread_ts: child.threads.brainstorm, text: `Child of <#${parent.channel_id}> (\`${parent.id}\`). Run \`/attack\` here to set an assumption, then \`/test\`.` })
		.catch(() => null);
	// D-52: pinned state card for the new child project.
	await upsertStateCard(client, id, { latestTs: childSeed?.ts, latestChannel: child.channelId });
	if (millChannel) {
		await client.chat
			.postMessage({ channel: millChannel, text: `*Spin-off* <#${child.channelId}> \`${id}\` from \`${parent.id}\` by ${founder}.` })
			.catch(() => {});
	}

	emit(buildEvalEvent({ stage: "spinoff", founder, ideaId: id, status: "ok", reasonCode: `parent_${parent.id}` }));
}

module.exports = { handleSpinoffCommand };
