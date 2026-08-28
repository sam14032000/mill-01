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

**Slack does not deliver slash commands typed inside a thread** ("That slash command is not supported in threads"). Chats and project stages are both threads, so a slash command is only usable from a channel's main compose box. This is a platform constraint, not a design choice — see D-51. Three ways to reach a command:

| Path | How | Confirmation |
|---|---|---|
| **Slash command** | Typed in a channel's main compose box (not a thread) | Runs immediately |
| **`@Mill <command> [args]`** | Mentioning the bot inside any thread, e.g. `@Mill attack` or `@Mill find dosa batter prices` | Runs immediately |
| **Tapped offer** | Say what you want in plain words ("attack this", "what would the others say"). If the intent is unambiguous the bot appends a one-tap button to its normal reply | Runs on tap |

The offer **never interrupts** — it is appended to the conversational reply and ignoring it costs nothing. It is made only on high confidence (explicit phrasing), deliberately under-offering; an incidental mention ("the counterargument is obvious") produces no offer. Offers **expire after two hours** and refuse if the conversation has moved past the turn that triggered them — a command built from a thread you can no longer see is exactly the confidently-wrong output the mill exists to prevent.

**Every gate fires identically on all three paths.** `@Mill` and the offer button both run the real command handler unchanged: `/proto`'s named-assumption requirement, `/audit`'s research-stub refusal and C-07 web-only downgrade, the five-touch cap. There is no shortcut path around a gate.

When a command needs a subject and none is given (`@Mill attack` with no text, or a tapped offer), the bot rebuilds it from the thread — the topic plus recent substantive turns — so the brainstorm commands see the idea under discussion, not the word "attack". `/proto` is the exception: it still refuses without an explicitly named assumption.

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

1–3 Tavily queries, results summarised in-thread. No report file, no citation re-check, no `evidence_basis`.

**It is never evidence.** Output must be visually distinct from a research report and must carry a footer saying so. If a chat is later promoted, `/find` results are transcribed as conversation, never as research. Only `/test` produces evidence an audit can rule on.

This distinction is load-bearing. Confusing surface search with research is how a `proceed` verdict gets built on three headlines.

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
3. Creates the project channel with its stage threads
4. Seeds the Brainstorm thread with a summary of the origin chat and a link back to the chat thread
5. Posts a link to the new channel in the chat thread and in `#mill-ideas`
6. Sets the assumption if one came from `/attack`; otherwise leaves it unset and notes that `/test` needs one

Retroactive, not prospective. A founder never has to decide up front whether a thought is worth a project.

---

## Projects

### Structure

Slack threads are one level deep — replying inside a thread stays in that thread. So stages are threads within a channel, not threads within a thread.

```
#idea-a3f9-batter
  ├─ 🧠 Brainstorm     ← /think /cross /blindspot /attack, conversation
  ├─ 🔍 Research       ← /test, field evidence, reports
  ├─ ⚖️  Audit          ← verdicts
  ├─ 🔨 Prototype      ← /proto, touches
  └─ 📎 Documents      ← uploads
```

Five anchor messages at creation; their `thread_ts` stored in `state.json`. Every command posts into its stage thread. Because these are threads, commands are run by `@Mill <command>` or a tapped offer, not a slash command — see "Running commands in threads" above.

**Context is keyed on `thread_ts`, never on channel.** One channel hosts four parallel conversations, and binding sessions at channel level causes silent context bleed — research findings leaking into brainstorm, prototype talk contaminating an audit.

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
  "touch_count": 0
}
```

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

**P3 — Project channels.** `channels:manage`, channel creation, stage threads, per-thread routing.

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
