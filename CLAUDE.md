# The Mill — Project Instructions

@docs/DECISIONS.md
@docs/runbook.md
@docs/COMMANDS.md

`docs/EVAL.md` is the monthly review protocol — deliberately **not** imported.
Layer 3 of that protocol must run in a fresh session with no build context,
so loading it here would defeat its purpose. Read it only when running the
review.

Three co-founders, phone-first, no development machines, $100/month all in.

This system exists to find out whether an idea is worth having. It is **not**
a delivery pipeline. Most ideas should die at the audit gate, and a `kill`
verdict is a success — it returns founder attention, which is scarcer than
the money.

`docs/DECISIONS.md` records why the structure is what it is. Read the
relevant entry before changing anything structural. If the revisit condition
has not been met, the decision stands — raise it with the founders rather
than acting on your own judgement.

---

## The loop

```
capture → brainstorm → research → AUDIT → prototype ⇄ touches
                                    ↓
                                   kill
```

Harness is **Pi**. Control surface is **Slack** via a custom Bolt bot
(D-39) — not `pi-chat`, which supports Discord and Telegram only. Provider
access through `pi-ai`.

---

## The evidence principle

Desk research is the weakest form of startup validation. Every research pass
gathers **web evidence** and asks the founder for **field evidence** — what
real people actually said.

**Web-only evidence caps the audit verdict at `narrow`. `proceed` requires
field evidence.** This rule is what stops the mill becoming a machine for
generating confident desk research. (D-33)

When field evidence is absent, the research pass outputs three questions that
would resolve the assumption and who to ask. That output is the point.

---

## Hard rules

- **Fable 5 runs at the audit gate and nowhere else.** Never from a
  background job, never a profile default. (D-10)
- **The auditor never sees the brainstorm transcript.** Assumption plus
  research report only. Enthusiasm makes for an agreeable auditor. (D-28)
- **Web-only evidence cannot yield `proceed`.** (D-33)
- **`/proto` refuses to run without a named assumption.** (D-29)
- **Touches cap at five iterations.** Then stop and ask whether the founders
  have decided to build. (D-29)
- **No claim without a retrieved source.** Unfound is `unresolved`, never
  "likely". (D-20)
- **Profile diffs are proposed, never auto-applied.** (D-30)
- **Raw captures arrive by DM, then land in the shared repo.** Not private after commit — all three founders can read them once pushed. (D-38, supersedes D-31)
- **No credentials reachable from the prototype container.** Pi ships no
  permission system; the sandbox is ours to enforce. (D-06)
- **Never modify `sshd_config` or restart ssh.** Founders do this by
  hand. (D-22)
- **Never run Pi outside its container for working prototypes.** (D-06)

---

## Models

| Stage | Model |
|---|---|
| capture (incl. voice) | Gemini 3.7 Flash — native audio |
| brainstorm | Gemini 3.7 Flash |
| research | Gemini 3.7 Flash + search plugin |
| **audit** | **Fable 5 — one pass, the only use** |
| prototype / touches | Gemini 3.7 Flash |
| profile evolution | Gemini 3.7 Flash |
| mechanical | MiniMax M3 |

Do not substitute models to save cost or because a better one appears.
Opus 5, Kimi K3 and DeepSeek were deliberately removed — read D-09, D-11
and D-07 before proposing any of them.

---

## Commands

| | |
|---|---|
| *(DM, non-command)* | capture, attributed to sender |
| `/think <idea>` | develop, then attack from that founder's blind spot |
| `/cross <idea>` | run through both other founders' profiles |
| `/blindspot <idea>` | attack from `shared/dynamics.md` |
| `/attack <idea>` | strongest case against → falsifiable assumption |
| `/test <assumption>` | research pass — prompts for field evidence first |
| `/audit <assumption>` | the gate — Fable, one pass |
| `/proto <assumption>` | smallest artifact testing that assumption |
| `/themes` | recurring preoccupations this month |

`/attack` must end in a falsifiable assumption. That assumption is the
handoff to research.

---

## Audit output format

Verdict, not essay:

- **Verdict:** proceed / narrow / kill
- **Evidence basis:** web-only / field-supported / both
- **Load-bearing assumption:** the one that, if false, makes the rest moot
- **Strongest reason this fails:** plainly, unhedged
- **What would change the verdict**
- **If web-only:** who to talk to before this can proceed

A `kill` writes to that founder's `graveyard.md` and posts to `#graveyard`.

---

## Slack layout

| Surface | Use |
|---|---|
| DM to bot | Private captures |
| `#mill` | Brainstorm, cross, blindspot |
| `#research` | Reports and audit verdicts, threaded |
| `#graveyard` | Kill verdicts |

Attribution drives profile routing and is not optional. Identity comes
only from Slack's verified `user_id` against a static allowlist — no
passphrase, no secondary login (D-40). Messages from off-allowlist IDs are
dropped silently: no reply, no capture.

---

## Pitfalls

- **Pi has no permission system.** It runs with the full permissions of the
  launching user. Working prototypes go in Docker with no host mount beyond
  scratch and no credentials in the environment. (D-06)
- **Cache the brainstorm prefix.** Profile plus recent captures is stable;
  cache hits cost 10% of base input. Without it, brainstorm costs three
  times as much.
- **Never use native model grounding for bulk search.** Grounding bills per
  query the model executes and can exceed the token cost of the task. (D-16)
- **Use `pi -p` with `--mode json`** for scripted stage runs, RPC for the
  Slack bot. Do not shell out to the interactive TUI.
- **Weekly cron cleanup** of node modules, Docker layers and browser
  binaries. Disk fills before memory does.

---

## Conventions

- Commit captures raw and unedited.
- Report cost per idea killed, not cost per token.
- Track kill rate at the gate. Below ~30%, say so — the audit isn't earning
  its 24% budget share.
- When adding a structural decision, add an entry to `DECISIONS.md` in the
  existing format. Never delete an entry — mark it superseded.
