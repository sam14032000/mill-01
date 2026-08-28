# COMMANDS — Application Specification

**Status:** the layer the build guide assumed a package would provide. It doesn't. This is the spec the bot implements against.

**Read with:** `runbook.md` (what each stage is for), `DECISIONS.md` (why), `CLAUDE.md` (hard rules).

---

## Idea lifecycle

A capture is not an idea. An idea exists once it has a falsifiable assumption.

```
capture ──/attack──▶ idea created ──/test──▶ researched ──/audit──▶ verdict
                                                                      │
                                                          kill ◀──────┴──────▶ /proto
```

**States**, stored in `ideas/<id>/state.json`:

| State | Set by | Means |
|---|---|---|
| `open` | `/attack` | Assumption exists, no research yet |
| `researched` | `/test` | Report written, awaiting audit |
| `audited` | `/audit` | Verdict recorded |
| `killed` | `/audit` | Terminal. Written to graveyard |
| `prototyping` | `/proto` | Artifact exists, touches counting |

**Idea ID:** 4-char lowercase hex, generated at `/attack`. Collision check against existing `ideas/`.

---

## File contract

```
minds/<founder>/
  captures/YYYY-MM-DD.md      append-only, never edited
  profile.md                  failure patterns (D-26)
  graveyard.md                killed ideas + reason

minds/shared/
  themes.md                   recurring preoccupations
  dynamics.md                 shared blind spots (D-27)

ideas/<id>/
  idea.md                     origin text + assumption + founder
  state.json                  state, timestamps, touch count
  field/                      founder-pasted evidence (GPT Researcher DOC_PATH)
  research-<stamp>.md         report
  research-<stamp>.json       {evidence_basis, sources[]}
  audit-<stamp>.json          verdict object
  proto/<n>/                  artifact per touch iteration

telemetry/YYYY-MM.jsonl       one event per command (schema in EVAL.md)
```

---

## Context assembly

Every command builds its prompt from parts. Order matters for prefix caching — **stable content first**, volatile last, or you lose the 10% cache-hit rate and brainstorm costs triple.

```
[1] system prompt for the command      ← stable
[2] founder profile.md                 ← stable within session
[3] shared/dynamics.md (blindspot only)← stable
[4] last 20 captures from this founder ← semi-stable
[5] the user's input                   ← volatile
```

**Cap [4] at 20 entries or ~8000 tokens, whichever is smaller.** Unbounded capture history means every brainstorm gets more expensive forever.

---

## Commands

### Capture — any DM that isn't a slash command

- **Model:** none for text. Gemini 3.7 Flash for voice notes (native audio, D-36)
- **Action:** append to `minds/<founder>/captures/YYYY-MM-DD.md` as `- HH:MM — <text>`
- **Reply:** react with ✅. No message. Friction kills this layer.
- **Commit:** batch every 15 minutes, not per capture
- **Unknown user_id:** ignore silently. No error, no file written.

---

### `/think <idea>`

- **Model:** flash-fast (`thinking_level: low`) · **Posts to:** `#mill-ideas`
- **Context:** [1][2][4]
- **System prompt:**
  > Develop this idea concretely — mechanism, who it serves, what has to be true.
  > Then attack it from the angle this founder's profile says they would miss.
  > The attack matters more than the development. Do not soften it.
  > End with the single weakest point, stated in one sentence.

---

### `/cross <idea>`

- **Model:** flash-fast (`thinking_level: low`), **two separate calls** · **Posts to:** `#mill-ideas`
- **Context:** [1] + *each other founder's* profile + the idea. Never the sender's profile.
- **System prompt (per call):**
  > You are reading this idea through the lens of a different founder's thinking patterns, given below. Attack it as they would.
  > Do not moderate or balance. One perspective only.
- **Output:** both readings, then one line: do they converge on the same objection or diverge? Convergence means the objection is real; divergence means multiple independent risks (D-27).

---

### `/blindspot <idea>`

- **Model:** flash-fast (`thinking_level: low`) · **Posts to:** `#mill-ideas`
- **Context:** [1][3] + idea. **No individual profile** — this is about all three.
- **System prompt:**
  > Attack from the shared blind spot described below. All three founders would miss this.
  > Agreement among three founders is not validation; it usually means shared priors.
  > Name what none of them would think to check.

---

### `/attack <idea>` — creates the idea

- **Model:** flash-fast (`thinking_level: low` — see D-08 amendment, `docs/DECISIONS.md`) · **Posts to:** `#mill-ideas`
- **Context:** [1][2] + idea
- **System prompt:**
  > Make the strongest case against this idea. Not balanced — the prosecution.
  > Then output the single assumption that, if false, kills it.
  > It must be falsifiable: something evidence could refute. "Users want this" is not falsifiable. "Users currently pay >$50/mo for a worse alternative" is.
  > The assumption must contain a number — a price, a percentage, or a count — and must name the specific alternative it's being displaced from. An assumption without both is not falsifiable enough to research.
  > Return the assumption alone on the final line, prefixed `ASSUMPTION:`.
  > If the idea doesn't name a specific customer, mechanism, or context precisely enough to attack, do not invent them. Instead return a single line, prefixed `TOO_VAGUE:`, naming the two or three specifics that would be needed before this could be attacked.
- **Writes:** `ideas/<id>/idea.md`, `state.json` → `open`
- **Reply:** the case, then the assumption and its id, e.g. `Created a3f9 — /test a3f9 to research it`
- **Fails if:** no `ASSUMPTION:` line returned. Retry once, then report failure. No idea created.
- **Refuses if:** the model returns `TOO_VAGUE:` instead of an assumption. Post the `TOO_VAGUE:` line as-is. No retry, no idea created — measured directly (`ops/BUILD-LOG.md`): before this refusal path existed, a deliberately unfalsifiable idea ("an AI app that helps people be more productive") got silently reframed into a plausible-looking assumption at every thinking level tried, which would have let it consume a $1.50 research pass and a $1.60 audit before the vagueness ever surfaced.

---

### `/test <id>` — research

**Two phases. The first is the point (D-33).**

**Phase 1 — field evidence.** Bot replies in thread:

> Before I research this — have you spoken to anyone?
> I'm most interested in what they **currently do**, not what they say they'd do:
> • What are they using today, and what does it cost them?
> • Have you seen the workaround — a spreadsheet, a WhatsApp group, a person they pay?
> • Did anyone name a price, or ask when they could buy?
>
> Paste it raw. Reply `none` if you haven't spoken to anyone yet.

The prompt asks for **behaviour, not intent** (I1) — what people currently do and pay, workarounds seen, prices named unprompted. Waits up to 30 minutes. A non-`none` reply is written to `ideas/<id>/field/notes-<stamp>.md` **raw and ungraded**; `/test` records `evidence_basis: field-raw` (or `web-only` on `none`/timeout). The audit grades it — `/test` never does.

**Phase 2 — the pass.** Runs `ops/research.py` (Part 11). Backgrounded; the bot must not block.

- **Model:** flash via LiteLLM · **Posts to:** the project's **Research** stage thread in `#idea-<id>-<slug>` (Part 16). Pre-projects ideas with no channel fall back to `#research`, retired for new work — D-47.
- **Report type:** standard, **never `deep`** — depth degrades factual accuracy while citation metrics stay flat
- **After the report:**
  1. **Citation check (D-20).** Re-fetch a sample of sources; confirm each supports the claim citing it. Decompose into sub-questions rather than judging holistically. Discrepancies appended to the report under `## Citation issues`.
  2. **Gap output.** If `evidence_basis` is `web-only`, emit three questions that would resolve the assumption and the kind of person to ask.
- **Writes:** `research-<stamp>.md`, `research-<stamp>.json`, state → `researched`
- **Reply on completion:** summary + verdict per assumption + `/audit <id> when ready`

---

### `/audit <id>` — the gate

- **Model:** **audit key only** (Fable 5). Never any other command. (D-10)
- **Posts to:** the project's **Audit** stage thread in `#idea-<id>-<slug>` (Part 16). Kills also post to `#graveyard`. Fallback for channel-less ideas: `#research` (retired — D-47).
- **Context:** `ideas/<id>/idea.md` (assumption only) + latest `research-<stamp>.md` + the **raw** field notes (`field/notes-*.md`, for the audit to grade — I1) + `ideas/<id>/outcomes.md` if it exists (prototype outcomes — I2) + a compact digest of all three founders' graveyards (id, assumption, kill reason, date — I3)
- **Explicitly NOT in context:** brainstorm output, `/think` or `/cross` results, the founder's profile, the founder's own characterisation of the field evidence, any enthusiasm. (D-28)
- **System prompt:**
  > Audit this assumption against the research provided. You are a gate, not an advisor.
  > CLASSIFY the field evidence yourself from the raw notes. Do not accept the founder's framing. `field-intent` = "they said they would". `field-behaviour` = observed current spend / a real workaround / a price named unprompted. `field-committed` = paid, pre-ordered, signed up, or did the thing.
  > `proceed` is only defensible on `field-behaviour` or `field-committed`. `web-only` and `field-intent` cap at `narrow`.
  > If this assumption is materially the same as one already killed (list below), say so and weight the earlier kill reason unless research shows it no longer holds — put its id in `resembles_killed_idea` (I3).
  > Be willing to kill. A kill returns founder attention, which is scarcer than money.
  > Return only the JSON object specified. No preamble.

**Output schema — validated before posting:**

```json
{
  "verdict": "proceed | narrow | kill",
  "evidence_basis": "none | web-only | field-intent | field-behaviour | field-committed"  // the audit assigns this by grading the raw field notes + prototype outcomes; it ignores any label already on the report
  "load_bearing_assumption": "the one that, if false, makes the rest moot",
  "strongest_failure_reason": "plainly, unhedged",
  "what_would_change_verdict": "…",
  "evidence_quality": "thin | adequate | strong",
  "who_to_talk_to": "required when evidence_basis is none / web-only / field-intent, else null",
  "resembles_killed_idea": "id of a previously-killed idea this assumption is materially the same as (I3), else null"
}
```

**Hard validation, enforced in code not prompt (C-07):**

- `verdict == "proceed"` && `evidence_basis ∈ {none, web-only, field-intent}` → **reject, downgrade to `narrow`**, log the violation (I1: `proceed` needs `field-behaviour` or `field-committed` — observed behaviour or a real commitment, never stated intent)
- **Grading is the audit's, from raw notes.** `field-intent` = "they said they would". `field-behaviour` = observed current spend / a workaround / a price named unprompted. `field-committed` = paid, pre-ordered, signed up, or did the thing (incl. in `ideas/<id>/outcomes.md`, I2).
- Malformed JSON → one retry, then report failure. Never post an unvalidated verdict.

**On `kill`:** append to `minds/<founder>/graveyard.md` with id, assumption, reason, date. Post to `#graveyard`. State → `killed`, terminal.

---

### `/proto <id> <assumption>`

- **Model:** flash-fast (`thinking_level: low`) · **Posts to:** `#mill-ideas`
- **Refuses if:** no assumption argument (D-29), or state is `killed`
- **System prompt:**
  > Build the smallest artifact that tests this one assumption. Default to non-code — landing page, mock flow, fake pricing table, one-pager. Single file.
  > Only write executable code if the assumption is technical.
  > This will be deleted. Do not build for durability.
- **Executable output:** runs in the Part 10 sandbox. Nothing else executes.
- **Writes:** `ideas/<id>/proto/<n>/`, increments `touch_count`, state → `prototyping`
- **At touch 5:** refuse further iterations and post:
  > Touch cap reached. Either this assumption was answered three touches ago, or you've decided to build this — which is a different conversation with a different budget.

---

### `/themes`

- **Model:** flash-fast (`thinking_level: low`) · **Posts to:** `#mill-ideas` · **Context:** last 30 days of that founder's captures
- **System prompt:**
  > What has this founder circled back to repeatedly? Name recurring preoccupations, not a summary.
  > Flag anything returned to more than twice without ever becoming an idea — that is a signal worth surfacing.

---

### `/chat <topic>` — projects phase (see `docs/PROJECTS.md`)

Opens a disposable thinking thread in `#chats`; plain replies are conversational turns with running context. Nothing is stored unless promoted. `flash-fast`.

### `/find <query>` — projects phase (see `docs/PROJECTS.md`)

Surface web lookup (1–3 Tavily queries, `flash-fast` summary) posted inline. **Never evidence** — carries a not-evidence footer, is visually distinct from a research report, and on promotion transcribes as conversation, never as research. `/search` is a Slack-reserved name, hence `/find`. Only `/test` produces something an audit can rule on.

---

## Profile evolution — weekly cron, not a command

Sunday 09:30. Per founder: reads the week's captures, their graveyard, and current `profile.md`.

- **Output:** a unified diff against `profile.md`, posted to that founder's DM with approve/reject buttons
- **Never auto-applied** (D-30). Rejected diffs are logged, not retried.
- **System prompt:**
  > Update this profile based on the week's evidence. The profile records **how this founder fails** — what they over-weight, which frames they default to, what they killed and why.
  > It does not record what they believe. A profile that reflects beliefs back is an echo chamber and defeats its purpose.
  > Propose only changes the week's evidence supports. Small diffs are correct.

`shared/dynamics.md` updates on the same run, posted to `#mill-ideas`, approved by any founder.

---

## Telemetry

Every command emits one line to `telemetry/YYYY-MM.jsonl` per the EVAL.md schema. Non-negotiable — without it the monthly review has nothing to judge and every falsifier is unevaluable.

Emit on failure too, with `"status": "failed"` and a reason. Failures are data.

---

## Failure handling

| Failure | Behaviour |
|---|---|
| LiteLLM budget exceeded | Post the budget error plainly to the invoking channel. Do not retry, do not fall back to another key. |
| Model call fails | One retry. Then report, emit telemetry, stop. |
| Malformed audit JSON | One retry. Then report failure. **Never post an unvalidated verdict.** |
| Research pass crashes | Post the traceback tail to the project's Research thread (or `#research` for channel-less ideas). Leave state at `open` so `/test` can re-run. |
| Unknown Slack user | Silent ignore. No reply, no file. |
| Git push fails | Log locally, alert to `#mill-ideas`, keep working. Never block a command on git. |

---

## What is deliberately not built

- No natural-language command parsing. Slash commands only.
- No idea search or listing UI. The repo is the interface.
- No editing captures. Append-only.
- No cross-founder notifications. `#mill-ideas` is shared; that is sufficient.
- No web UI of any kind.

Every one of these is a place scope would expand without improving the kill rate.
