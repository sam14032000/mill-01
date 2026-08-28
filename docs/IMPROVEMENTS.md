# IMPROVEMENTS — Post-Build Queue

**Status:** do not start until Parts 14–19 are complete and commissioned.
**Read with:** `COMMANDS.md`, `PROJECTS.md`, `DECISIONS.md`, `EVAL.md`.

These came out of an audit of the full flow against current validation practice. The structure held up; every gap found was at the **evidence layer**. Ordered by how much each changes verdict quality.

Build I1 and I2 together — they are the same problem from two ends. I3–I5 are independent and can be taken in any order.

---

## I1 — Grade field evidence: behaviour outranks intent

**The hole.** The audit treats all field evidence as equal. "My friend said he'd totally use this" currently qualifies as `field-supported` and is therefore eligible for `proceed`. That is the exact failure D-33 was built to prevent, arriving through the door D-33 opened.

**Why it matters.** Surveys systematically overestimate willingness to pay by around 21%. The corrective is structured past-behaviour questioning — what people currently do and pay — rather than intent questions about what they would do.

**Changes:**

**Field prompt** (`/test` phase 1) — replace the current wording with something that asks for behaviour:

> Before I research this — have you spoken to anyone?
> I'm most interested in what they **currently do**, not what they say they'd do:
> • What are they using today, and what does it cost them?
> • Have you seen the workaround — a spreadsheet, a WhatsApp group, a person they pay?
> • Did anyone name a price, or ask when they could buy?
>
> Paste it raw. Reply `none` if you haven't spoken to anyone yet.

**Schema** — `evidence_basis` gains a grade. Replace the current three values with:

| Value | Means |
|---|---|
| `none` | No research has run |
| `web-only` | Published sources only |
| `field-intent` | People said what they *would* do |
| `field-behaviour` | Observed current spend, workarounds, or a price named unprompted |
| `field-committed` | Someone paid, pre-ordered, or signed up |

**Gate, enforced in code after JSON parsing — not by prompt:**

- `proceed` requires `field-behaviour` or `field-committed`
- `web-only` and `field-intent` both cap at `narrow`
- Existing C-07 extends to cover `field-intent`

**Classification** is the audit's job — it reads the raw field notes and grades them. It must not accept the founder's own characterisation.

**Verify:** paste intent-only evidence ("three people said they'd pay") and confirm the verdict caps at `narrow` with `evidence_basis: field-intent`. Paste behavioural evidence ("two of them showed me the ₹800/month tool they use now") and confirm `field-behaviour` and that `proceed` becomes available.

---

## I2 — Close the loop: capture outcomes at dismount

**The hole.** The lifecycle ends at `prototype ⇄ touches`. Nothing records what happened when a real person saw the prototype. The strongest evidence a mill can produce — someone clicked, signed up, paid — has nowhere to live, so it never reaches an audit.

**The hook** is dismount. The founder has just finished showing it to someone.

**On `[ Dismount ]` or auto-expiry**, post in the Prototype thread:

> Prototype dismounted after 34 minutes.
> • Who saw it?
> • What did they actually do — clicked, asked a question, signed up, paid, went quiet?
> • Anything they said about price?
>
> Reply `nobody` if it was just you.

Write the reply to `ideas/<id>/outcomes.md`, appended with timestamp and founder.

**Feed it forward.** `outcomes.md` becomes audit context alongside the research report. An outcome recording a signup or payment is what upgrades an idea to `field-committed`.

**Use what you already have.** The ngrok request inspector at `localhost:4040` shows whether the URL was opened at all. Include a request count in the dismount prompt — "the page was opened 3 times" is a fact the founder can react to, and "opened 0 times" is itself a finding.

**Verify:** mount, open the URL twice from a phone on mobile data, dismount, confirm the prompt reports 2 requests and that a reply writes to `outcomes.md`. Then run `/audit` and confirm the outcomes file appears in context.

---

## I3 — The auditor should read the graveyard

**The hole.** Fable sees the assumption and the research report. It does not see what has already been killed and why — so it cannot say "this is your June idea renamed, killed for a reason that still applies." EVAL tracks graveyard resurrections as a metric; nothing prevents them.

**Change.** Include a compact digest of all three founders' graveyards in audit context: idea title, assumption, kill reason, date. Titles and reasons only, not full histories — a few hundred tokens.

Add to the audit system prompt:

> Previously killed ideas are listed below. If this assumption is materially the same as one already killed, say so explicitly and weight the earlier kill reason — unless the research shows the reason no longer holds.

**Add to the audit output schema:** `resembles_killed_idea` — the id, or null.

**Verify:** kill an idea, then submit a lightly reworded version of the same assumption. Confirm the audit flags the resemblance and cites the original kill reason.

---

## I4 — Ideas move or die

**The hole.** Nothing enforces motion. An idea can sit at `researched` forever. EVAL targets a median capture-to-verdict of under 10 days with no mechanism behind it, and a parked idea is parked attention — the scarce resource the whole mill is built to protect.

**Change.** Daily cron checks `state.json` timestamps. At 14 days without a state change, post in the project channel:

> `a3f9` has been at `researched` for 14 days.
> `/audit a3f9` — or kill it and take the attention back.
> **[ Kill it ]**

The button records `stale` as the kill reason. That is a legitimate verdict: an idea nobody has returned to in two weeks has been answered by inattention.

One nudge, not a recurring nag. Repeat at 30 days, then stop.

**Verify:** backdate a `state.json` timestamp, run the cron, confirm the nudge posts once and that the Kill button writes to the graveyard with reason `stale`.

---

## I5 — Tell research it is operating in India

**The hole.** Assumptions here are Bangalore batter, Indian GST filings, Pune hardware startups. A generic research pass under-serves Indian market data — pricing in the wrong currency, US competitors, no local regulatory context.

**Change.** Add to the research system prompt, applied when the assumption is India-anchored:

> This assumption concerns an Indian market. Prioritise India-specific sources: local competitors, pricing in ₹, Indian regulatory and tax context, and Indian community discussion. A US comparable is context, not evidence — say so when you use one.

**Pair with a retriever comparison.** Tavily was chosen because GPT Researcher defaults to it, not because it was compared. "Who else does this in India" is semantic search rather than keyword search, which is Exa's shape.

Run the same three real assumptions through Tavily and Exa via the existing swappable `ops/search.py` interface. Compare returned sources for India relevance, then decide. Do this with real assumptions from actual use, not invented ones.

**Verify:** run an India-anchored assumption and confirm the report cites Indian sources with ₹ pricing rather than US comparables presented as evidence.

---

## Deliberately not adopted

**Synthetic AI customer personas.** The most-hyped shift in 2026 validation practice, and a machine for generating exactly the fake `field-supported` evidence this gate exists to block. If it enters the flow, I1 becomes theatre.

**Idea scoring.** Commercial validators return a viability score out of 100. A number without linked evidence is autocomplete dressed as a confidence interval. Verdicts here stay `proceed` / `narrow` / `kill` with a stated reason.

**More research depth.** Increased search depth degrades factual accuracy while citation metrics stay flat. If verdict quality is weak, the fix is better evidence grading, not deeper passes.

---

## After these land

Re-run `EVAL.md` and check two numbers specifically:

- **Kill rate** — should rise. I1 and I3 both make the gate stricter.
- **`field-behaviour` share** — should rise over time. If it stays at zero, the mill has become a substitute for the conversations rather than preparation for them, which is the failure the whole system is least able to detect on its own.
