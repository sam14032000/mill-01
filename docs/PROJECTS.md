# PROJECTS — Chats, Projects, and Documents

**Status:** spec. Supersedes the flat `#mill-ideas` / `#research` structure in runbook.md.
**Read with:** `COMMANDS.md` (command behaviour), `DECISIONS.md` (why).

---

## Two tiers

**Chat** is cheap and disposable. Think out loud, run the brainstorm commands, do a surface web search. Nothing is stored in the repo. Most chats go nowhere, which is correct.

**Project** is durable. Documents, deep research, prototyping, the audit gate. Created only by an explicit act.

```
CHAT                                    PROJECT
────                                    ───────
/think /cross /blindspot /attack        everything a chat can do
surface web search                    + /test  (deep research)
                                      + /proto (prototyping)
                                      + /audit (the gate)
                                      + document storage
no repo footprint                     + ideas/<id>/ in the repo
flash-fast only                       + research, audit
        │                                   ▲
        └────── "Start a project" ──────────┘
```

The promotion is a gate, in the same sense the audit is. Most ideas should never reach it — and one that a founder won't spend ten seconds promoting was not worth a research pass.

---

## Running commands in threads

**Slack does not deliver slash commands typed inside a thread** ("That slash command is not supported in threads"). Chats and project stages are both threads, so a slash command is only usable from a channel's main compose box. This is a platform constraint, not a design choice — see D-51. Two ways to reach a command (D-53):

| Path | How |
|---|---|
| **Deliberate** | A slash command from a channel's compose box, `@Mill <command> [args]` in a thread, or a Block Kit button. Runs the command immediately — no model decides anything. |
| **Conversational** | Just say something in the thread. The agent loop gets the tool set + the thread context and decides: run one command, or reply in prose. |

**The agent's default is to reply.** It runs a tool only when your latest message is an explicit instruction to run that job ("attack this", "look up what iD Fresh charges", "run the research pass"). A statement, a musing, or a question ("didn't we…", "what about…", "is that defensible?") gets a prose answer — a question is a request only if it explicitly asks to run something ("can you attack this?"). Prior tool output in the thread is context, never a signal to run it again. When it runs a tool it writes **no prose** — the command owns the response. One tool per turn; you drive the next step.

**Every gate fires regardless of path.** `/proto`'s named-assumption requirement, `/audit`'s research-stub refusal and C-07 web-only downgrade, the five-touch cap — enforced inside the command handlers. The agent can't route around them.

**Commands see the conversation, not just your message.** A brainstorm command invoked from a thread is handed that thread's running context — recent turns, plus the project's `origin-chat.md` in a stage thread — and treats the conversation as the idea. `/find` and `/test` resolve referring expressions ("research *these*") against it before building queries; every project stage thread can answer "where did we leave off" from the origin chat.

---

## Chats

### Starting one

A founder DMs Mill, or runs `/chat <topic>`. The bot opens a thread in `#chats` and replies there.

`#chats` is shared, so any founder can read or join any session. Sessions are per-thread; the founder who started it owns it for profile-routing purposes, but anyone can contribute.

### What works in a chat

| | |
|---|---|
| `/think` `/cross` `/blindspot` `/themes` | Full behaviour |
| `/attack` | Produces the assumption. Creates **no** idea — see below |
| `/find <query>` | New. Surface web search, 1–3 queries, summarised inline (`/search` is reserved by Slack) |
| Plain messages | Conversational brainstorming in-thread |

Commands here are invoked by `@Mill <command>` or a tapped offer, since the chat is a thread (see "Running commands in threads"). `/chat` itself is the exception — it starts the thread from the `#chats` compose box.

**Session context** is keyed on `thread_ts` and holds the running conversation, the founder's profile, and recent captures. It does not persist to the repo.

### `/attack` in a chat

Returns the strongest case against plus the `ASSUMPTION:` line, exactly as specified in COMMANDS.md — but writes nothing. The promote button is then presented **pre-filled with that assumption**, so promoting immediately creates a project with the assumption already set.

This is the intended path into a project: think, attack, promote.

### `/find` — surface only

Tavily queries, no citation re-check, no `evidence_basis`. Founder invocations (`/find`, `@Mill find`, or asking the agent to dig in) run **broad** — 5 sub-queries, 8 results each; breadth, not depth (D-53). In a project the full report is written to `ideas/<id>/find/<stamp>.md`, committed, attached to the thread, and indexed in `ideas/<id>/find/index.md`; that index is loaded into **every thread of the project**, so a report run in one stage thread is referenceable from all of them. Slack gets a rundown that fits its limit plus the attachment, not the whole report. `find/` is deliberately **separate from `docs/`** — a surface search must never reach `/test`'s `DOC_PATH` or the audit as a document. In a bare `#chats` it's a capped inline message. The agent may also run a **quick** inline check on its own — 1–2 queries folded into a reply, no file — when it needs one concrete missing fact; that carries a `_(quick web check — not verified, not evidence)_` marker and no separate block.

**It is never evidence** — in either mode. Output must be visually distinct from a research report and carry a footer saying so. If a chat is later promoted, `/find` results are transcribed as conversation, never as research. Only `/test` produces evidence an audit can rule on.

This distinction is load-bearing. Confusing surface search with research is how a `proceed` verdict gets built on three headlines — and an agent-initiated search the founder didn't ask for is more at risk of being mistaken for evidence, not less.

### Persistence

Chat threads live in Slack, not the repo. Nightly, each founder's own messages from unpromoted chats are appended to their captures file — so raw thinking is never lost, per the raw-capture rule.

The full transcript enters the repo only on promotion.

⚠️ **Slack's free plan limits history retention.** Verify the current limit for your workspace. If it's short, either promote anything worth keeping or move the nightly job to capture full transcripts rather than just the founder's messages.

---

## Promotion

### The button

Every bot reply in a chat thread carries a Block Kit action:

> **[ Start a project from this idea ]**

Always available, no threshold. Ten seconds, one tap.

### Triggered prompts

The bot offers promotion unprompted when a founder hits a chat's ceiling:

| Founder does | Bot replies |
|---|---|
| Uploads a file | "I can't store files in a chat — start a project and I'll keep it with the idea." + button |
| Runs `/test`, `/proto`, `/audit` | "That needs a project." + button |
| Asks to build, save, or keep something | Same |

Never silently refuse. The button is always the next step.

### What promotion does

1. Generates an idea id, creates `ideas/<id>/`
2. Writes the **full chat transcript** to `ideas/<id>/origin-chat.md` — this is the idea's memory, and the reason promoting late loses nothing
3. Creates the project channel and its first chat (whose card is that chat's thread root)
4. **Transfers the chat turn by turn** into that first chat — each turn reposted in order, attributed (`*saksham:*` / `*Mill:*`), verbatim. Slack cannot move messages between channels, so "attach" means replaying the conversation as it read, not collapsing it into a summary
5. Posts a link to the new channel in the chat thread and in `#mill-ideas`
6. Sets the assumption if one came from `/attack`; otherwise leaves it unset and notes that `/test` needs one

Retroactive, not prospective. A founder never has to decide up front whether a thought is worth a project.

---

## Projects

### Structure — chats and modes (supersedes the five stage threads)

A project channel holds **many chats**. Each chat is a Slack thread whose **root message is its card**; replies to it are the conversation. Card and conversation are therefore the same thread by construction and cannot drift apart.

```
#idea-a3f9-batter
  ├─ 💬 Customs wedge      ← a chat. Its card is the thread root.        [📋 product ▾]
  ├─ 💬 Pricing model      ← another chat, in its own mode.              [🧠 brainstorm ▾]
  └─ 💬 Returns            ← the last active one is the pinned card.     [🔧 engineering ▾]
```

**Superseded:** the five per-stage anchor threads (Brainstorm / Research / Audit / Prototype / Documents). A stage is no longer a thread — it is a **mode** on a chat, and the same chat moves between modes.

**Modes.** Each chat carries one, changed by the `static_select` on its card or `@Mill mode <name>`:

| Mode | Persona | Owns | Refuses |
|---|---|---|---|
| brainstorm | Co-founder | `research-kb.md` | an unfalsifiable claim |
| product | PM | `product-spec.md` | a feature with no user/JTBD/metric; prescribing implementation |
| engineering | Engineer | `engineering-spec.md` | a design with no failure modes/cost; reopening product decisions |
| proto | Builder | artifacts | building with no engineering spec |
| deck *(branch)* | Deck writer | `deck.md` | a slide with no audience and no intended effect |
| audit | Auditor | the verdict is the gate's | giving a verdict in conversation |

Modes are sequential in **dependency** (each persona's input is the previous mode's document) but never in **gating** — switching is always allowed. `deck` is a branch off brainstorm, not a link in the chain (D-56).

**Documents carry context between stages, not the thread** (D-57). A document is written when you ask for it — "create the product spec", "update it with what we just said", `@Mill save` — and is reconciled with the conversation rather than regenerated, so prior specifics survive. It draws only on turns spoken in its own mode. Nothing writes a document automatically; the only unprompted thing is the button-gated offer when a mode's *input* document is missing or stale.

**Context is keyed on `thread_ts`, never on channel.** One channel hosts several parallel chats, and binding sessions at channel level causes silent context bleed.

### The pinned card

Exactly **one card is pinned per project: the last active chat.** It is that chat's thread root, re-rendered on every transition and whenever the chat is active, and `repin` unpins the previous so the channel pin is never ambiguous.

The card shows the chat title and who opened it, the assumption, the document chain as **links** (`research KB · product spec · engineering spec · audit report`, present ones hyperlinked), and a "▶ Continue where you left off" permalink to the newest message in that chat. The mode lives on the `static_select` accessory rather than in the text — the control *is* the status display.

**Deliberately not shown:** the `open/researched/audited` lifecycle and a prescribed "Next: run X" line. Both encoded D-41's linear pipeline that modes replaced, and both went stale on their own.

### Naming and membership

`#idea-<id>-<slug>`, lowercase, ≤80 chars. All three founders auto-invited. Topic is the assumption once one exists.

Requires the `channels:manage` scope, which the app does not yet have.

### Spin-off

`/spinoff <new idea>` from inside a project creates a child project and records lineage both ways:

```json
"children": ["b7c2"]      // parent
"parent": "a3f9"          // child
```

An idea that spawns three children which all die tells you something the individual verdicts don't.

From a *chat*, there is no spin-off — just start another chat. Chats are free.

### Archive on kill

A `kill` verdict archives the channel after posting. History is retained; it stops occupying the sidebar.

This gives killing a visible action, and turns the graveyard from a file nobody opens into a browsable set of archived channels.

---

## Documents

Projects only. This is the main thing a chat cannot do.

### Capture

On `file_shared` in a project channel:

1. Download via `files.info` → `url_private` with the bot token
2. Write to `ideas/<id>/docs/<filename>`
3. On collision suffix `-2`, `-3` — never overwrite
4. Commit, attributed to the uploader
5. React ✅

**Slack is not storage.** Files there are subject to plan retention. Download at upload time, never lazily.

### Size limits

| Size | Behaviour |
|---|---|
| < 5 MB | Accept |
| 5–20 MB | Accept, warn that large files bloat the repo |
| > 20 MB | Refuse; ask for an extract |

Git keeps every version of every binary forever, on a 40 GB disk.

### Indexing

On upload, generate an index entry with `flash-fast` (the `mechanical`/MiniMax tier was removed — D-46):

```markdown
## market-report-q2.pdf
uploaded by saksham · 2026-08-27 · 2.3 MB · 47 pages
Type: third-party market research
Summary: [~150 words]
Key figures: [3–5 bullets, numbers only]
```

Appended to `ideas/<id>/docs/index.md`.

PDF and images go to Gemini natively. `.docx`/`.xlsx` need conversion. Text and markdown pass through.

### How documents reach the model

**Default: index only.** Brainstorm gets `index.md`, not document bodies. A 47-page report is ~30k tokens; resending it across twenty turns is 600k tokens for content the founder has already read.

**On demand:** `/think @market-report.pdf <question>` includes that document's full text for that call only.
**Everything:** `/think @all <question>` — roughly $0.15 at 200k tokens. Occasionally worth it.

**Research is the exception.** `/test` passes `ideas/<id>/docs/` as GPT Researcher's `DOC_PATH`, which is the hybrid-mode mechanism behind D-33.

**Audit gets the index, not the documents.** Documents reach it only as cited in the research report.

**Cache ordering:** `index.md` is stable within a session, so it belongs in the cached prefix beside the profile — before captures, before user input.

---

## Channel roles

| Channel | Role |
|---|---|
| `#chats` | All chat sessions, one thread each |
| `#mill-ideas` | Lobby. Promotion announcements, `/themes` |
| `#graveyard` | Kill feed across all projects |
| `#research` | **Retired** — reports live in each project's Research thread |
| `#idea-*` | The work |

---

## `state.json`

```json
{
  "id": "a3f9",
  "state": "open",
  "founder": "saksham",
  "channel_id": "C09ABCDEF",
  "origin_chat_ts": "1756...",
  "threads": {
    "brainstorm": "1756...",
    "research":   "1756...",
    "audit":      "1756...",
    "prototype":  "1756...",
    "documents":  "1756..."
  },
  "parent": null,
  "children": [],
  "touch_count": 0,
  "state_card_ts": "1756...",
  "assumption_blocked_on": null
}
```

`state_card_ts` is the pinned state card's message ts (D-52); `assumption_blocked_on` carries `/attack`'s `TOO_VAGUE` specifics when promotion couldn't set an assumption.

---

## Failure handling

| Failure | Behaviour |
|---|---|
| Channel creation fails during promotion | Do not create the idea. Report plainly and leave the chat intact. A half-promoted idea is worse than none. |
| File download fails | Retry once, then post the failure with the filename. **Never silently drop an upload.** |
| Extraction fails | Store the raw file, mark the index entry `extraction failed`. |
| `thread_ts` missing | Repost anchors, update state, warn. Never post to channel root. |
| Archive fails on kill | Log and alert. The verdict stands. |
| Expensive command in a chat | Offer the button. Never silently refuse, never silently run it. |

---

## Build order

**P1 — Chat tier.** `#chats`, `/chat`, per-thread sessions, `/find`, the nightly capture job. Brainstorm commands work here already; this is mostly routing.

**P2 — Promotion.** The button, triggered prompts, transcript capture, idea creation. Project channels can wait — promote into the current flat structure first.

**P3 — Project channels.** `channels:manage`, channel creation, chats-with-modes, per-thread routing.

**P4 — Documents.** Upload capture, size limits, indexing, the context rules.

**P5 — Lifecycle.** Archive on kill, `/spinoff`, lineage.

P4 is what made this urgent, but it depends on P3 — documents need somewhere to live. If uploads are blocking sooner than that, an interim option is accepting them into the current flat `ideas/<id>/docs/` and adding channels afterwards.

---

## Deliberately not built

- **No RAG for brainstorm.** Flash has a 1M context and 97% long-context retrieval. Index plus `@filename` plus `@all` covers a ten-document corpus without a vector store and its silent retrieval failures. Revisit past ~20 documents per idea.
- **No document versioning.** Re-uploading creates a new file; git holds history.
- **No cross-idea document search.** Repo and Slack search suffice.
- **No auto-linking documents to assumptions.** A founder naming the relevant document is cheaper and more accurate than inferring it.
- **No promotion heuristics.** The bot never decides an idea deserves a project. Only a founder does.
