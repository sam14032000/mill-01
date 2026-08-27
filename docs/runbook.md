# The Mill — Operations Runbook

**Version:** 3.0 · August 2026 · supersedes v2.0
**Operators:** three co-founders, India · phone-first · no development machines
**Budget:** $100/month, all in
**Purpose:** find out whether an idea is worth having, as cheaply and as often as possible

**Changed in 3.0:** harness moved from dsh to Pi, then Pi removed entirely (D-43) once LiteLLM plus the custom Slack bot were confirmed to already cover every job the harness was chosen for. Control surface moved from Telegram to Slack. Research now merges web evidence with field evidence from the founders.

---

## What this is

Not a delivery pipeline. A mill that ideas go into and mostly die in.

```
capture → brainstorm → research → AUDIT → prototype ⇄ touches
                                    ↓
                                   kill
```

The metric is **cost per idea killed**. A `kill` verdict is a success — it returns founder attention, which is scarcer than the money.

Most passes should end at the gate. If they don't, the gate is too permissive.

---

## The evidence principle

**Desk research is the weakest form of startup validation.** What kills or confirms an early idea is talking to people who would pay for it. The mill exists to make you *ready* for those conversations and to sharpen what you learn from them — not to substitute for them.

So every research pass has two halves:

| | |
|---|---|
| **Web evidence** | What published sources say. Always gathered. |
| **Field evidence** | What the founders have heard from real people. Gathered when it exists. |

When field evidence is absent, the research pass doesn't shrug — it produces **the three questions that would resolve the assumption, and who to ask**. That output is the point. A pass with no field data should leave you with a call to make.

**The audit weights these differently.** An assumption supported only by web evidence caps at `narrow`, never `proceed`. Published information tells you a market exists; it cannot tell you anyone will buy from you.

---

## Stage 1 — Capture

**Always on. No model cost.**

Ideas land while walking. Any friction and the layer goes unused, which degrades the profiles and every brainstorm downstream.

- Any message to the bot that isn't a slash command is a capture
- Voice notes go straight to Gemini 3.7 Flash, which accepts audio natively — no separate transcription service
- Timestamped, attributed, committed raw, **never edited**
- **No categorisation at capture time.** Triage later or not at all

```
minds/
  saksham/  captures/YYYY-MM-DD.md
            profile.md
            graveyard.md
  amisha/   …
  vaibhav/  …
  shared/
    themes.md      recurring preoccupations across all three
    dynamics.md    where the three of you converge too fast
```

**Slack layout**

| Channel | Purpose |
|---|---|
| DM to the bot | Private captures — one per founder |
| `#mill-ideas` | Brainstorm, cross, blindspot. Shared. |
| `#research` | Research reports and audit verdicts, threaded |
| `#graveyard` | Kill verdicts. Read it monthly. |

Raw captures stay in DMs by default. Profiles, themes and dynamics are shared. Half-formed 2am thoughts are not always things people want read.

---

## Stage 2 — Brainstorm

**Interactive. Gemini 3.7 Flash. High frequency, low cost per exchange.**

| Command | What it does |
|---|---|
| `/think <idea>` | Develops it, then attacks from an angle your profile says you'd miss |
| `/cross <idea>` | Runs it through the other two founders' profiles — two distinct outside angles |
| `/blindspot <idea>` | Attacks from `shared/dynamics.md` — what all three of you would miss |
| `/attack <idea>` | Strongest case against, ending in a falsifiable assumption |
| `/themes` | What you've circled back to this month |

**Reading `/cross`.** Two other profiles means two independent readings. Convergence on the same objection means the objection is real. Divergence means the idea carries several independent risks. Both are signal.

**`/blindspot` exists because three founders is more dangerous than two.** Agreement among three feels like validation. It usually means shared priors.

**`/attack` is the handoff.** It must end with a falsifiable assumption. No assumption, no research pass — otherwise research becomes reading around a topic instead of testing a claim.

Cache the prefix: profile plus recent captures is stable within a session, and cache hits cost 10% of base input. Without caching this stage costs roughly three times as much.

---

## Stage 3 — Research

**Background. Gemini 3.7 Flash + search plugin. Runs while you're not watching.**

Ungated deliberately — at roughly $1.50 a pass, research is cheap enough to run on hunches and expensive to bottleneck.

`/test <assumption>` starts it. The bot **first asks the founder** in-thread:

> Have you spoken to anyone about this? Paste anything you've heard — quotes, objections, prices people named, who they were. Or reply `none`.

Then the pass runs:

1. **Web half.** Searches, fetches primary sources, reads them. Every claim carries a URL actually retrieved. No inference — unfound is `unresolved`, never "likely".
2. **Field half.** Structures whatever the founder pasted. Marks what it supports and what it doesn't.
3. **Synthesis.** Marks the assumption `supported` / `refuted` / `unresolved`, stating which half carried the verdict.
4. **Gap output.** If field evidence is thin or absent: three specific questions that would resolve the assumption, and the kind of person to ask.
5. **Citation check.** Re-fetches a sample of cited URLs and confirms they say what the report claims.

That last step is the cheap guard against the failure that actually kills founders. You would rather kill a good idea on weak evidence than build for six months on a hallucinated confirmation.

Report posts to `#research` as a thread. Notification on completion.

---

## Stage 4 — Audit

**The gate. Claude Fable 5. One pass. ~$1.60.**

The only place a frontier model is used, guarding the most expensive downstream resource — founder attention.

**Input:** the assumption as stated, plus the research report. **Not** the brainstorm transcript — give the auditor the enthusiasm that produced the idea and you get a more agreeable auditor.

**Output — verdict, not essay:**

- **Verdict:** proceed / narrow / kill
- **Evidence basis:** web-only / field-supported / both
- **Load-bearing assumption:** the one that, if false, makes the rest moot
- **Strongest reason this fails:** plainly, unhedged
- **What would change the verdict**
- **If web-only:** who to talk to before this can proceed

**Hard rule: web-only evidence caps at `narrow`.** `proceed` requires field evidence. This is the mechanism that stops the mill becoming a machine for generating confident desk research.

A `kill` writes to that founder's `graveyard.md` with the reason and posts to `#graveyard`.

**Track the kill rate.** Below ~30% and the gate isn't earning its 24% share of the budget — either the prompt is too permissive or ideas aren't reaching it raw enough.

---

## Stage 5 — Prototype

**Gemini 3.7 Flash. Minutes, not nights.**

`/proto <assumption>` — **refuses to run without a named assumption.**

Most prototypes are not code:

- **Artifact prototypes (most):** landing page, mock UI, fake pricing table, one-page pitch. Single file, committed, viewable from a phone. Often the thing you put in front of the people the audit told you to call.
- **Working prototypes (occasional):** something that runs because the assumption is technical — does this API return usable data, is this scrape viable. Sandboxed in Docker, throwaway.

**Deletion is the default.** A prototype exists to kill or advance one named assumption, then goes. If any founder wants to keep one, stop — that's a decision to build, a different conversation with a different budget.

---

## Stage 6 — Touches

**The loop with no natural terminator. Guard it.**

- Each iteration names what it improves and why that matters to the assumption under test. "Make it nicer" doesn't qualify.
- **Hard cap: five iterations.**

This is where validation quietly becomes product development. The cap is the tripwire.

---

## Profile evolution

**Weekly. Gemini 3.7 Flash. Human-gated.**

Profiles record **how you fail**, not what you believe — what you over-weight, which frames you default to, what you've killed and what killed it, where the three of you converge too fast. A profile that learns your beliefs and feeds them back is an echo chamber, which is the opposite of the point.

Each Sunday a job reads the week's captures and graveyard, then proposes a **diff** to that founder's DM for approval. Never auto-applied — the profile shapes every brainstorm downstream, and drift is gradual enough that nobody notices until outputs have gone generic.

Each founder reads and hand-corrects their own profile monthly. It will be wrong about you in ways only you can see.

---

## Budget

| Line | Monthly |
|---|---|
| Droplet, 2GB + 4GB swap | $12 |
| Brainstorm, cached (~150 exchanges) | $8 |
| Profile evolution (3 + shared) | $4 |
| Research (~16 passes @ $1.50) | $24 |
| **Audit — Fable 5 (~15 @ $1.60)** | **$24** |
| Prototype + touches | $12 |
| Mechanical (MiniMax M3) | $3 |
| Buffer | $13 |
| **Total** | **$100** |

Slack free tier is adequate. Transcription is gone — Gemini handles audio natively.

**Per founder: roughly five research passes and five audits a month** — about one idea fully processed per founder per week.

**If you need headroom,** move off DigitalOcean: Hetzner CX22 gives 4GB for about $4.10 against $12, freeing roughly five more audits.

**Spend caps** (DECISIONS D-23): per provider, at ~1.5× expected. Fable's line is a tripwire — gate-only use means above $35/month something is calling it outside the gate.

---

## Infrastructure

| Component | Choice |
|---|---|
| Host | 2GB / 1–2 vCPU, 4GB swap |
| Harness | **None** (D-43) — every command calls LiteLLM's `/chat/completions` directly |
| Provider layer | **LiteLLM** — one proxy across every model, swappable via `config.yaml` |
| Control surface | **Slack**, via a custom Bolt bot (D-39) |
| Sandbox | **Docker — you build this.** Generated code has no permission system of its own. |
| Access | Tailscale, SSH only. No web UI to expose. |
| Memory | git repo |

**The sandbox is on you.** Model-generated code runs with the full permissions of whatever executes it unless you containerize. Working prototypes execute in a Docker container with no host mount beyond a scratch directory and no credentials in the environment — see DECISIONS D-06.

**Weekly cron cleanup** of node modules, Docker layers and browser binaries. Disk fills before memory does.

---

## Before you build any of this

Run the loop by hand for two weeks. Three founders, a shared doc, one paid audit each. You will find out which parts you actually use — and the honest guess is that capture and `/blindspot` get used constantly while the research apparatus gets used twice.

A week of setup and $100/month is itself an idea that hasn't been through the mill.
