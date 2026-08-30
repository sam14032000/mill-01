# Build Prompt — Modes, Personas, Staged Documents

**Supersedes** the earlier three-changes prompt entirely — do not build from that one. Read `docs/PROJECTS.md`, `docs/COMMANDS.md` and `docs/DECISIONS.md` first. This restructures projects and supersedes D-47 (five stage threads) and parts of D-28.

**Build order:** Change 5 first (small, independent), then 2, 1, 3, 4. Report after each. Changes 1 and 4 are the risky pair.

---

## CHANGE 1 — One thread per project, with modes

Replace the five stage threads with a single project thread and an explicit mode.

| Mode | Persona | Produces |
|---|---|---|
| **Brainstorm** (mandatory start) | Co-founder | Research knowledge base |
| **Product planning** | PM | Product spec |
| **Engineering planning** | Engineer | Engineering spec |
| **Proto** | Builder | Artifacts, mounts |
| **Audit** | Auditor | Verdict |

**Every project starts in brainstorm. It is not skippable as an entry point.**

Mode persisted in `state.json`, displayed in-thread on every switch, changed by command or button.

**No information boundary in the thread.** Full history visible in every mode. The only scoped context is the audit tool's (Change 2).

**Modes do not gate each other.** Each has an input requirement it will auto-fill with permission (Change 3).

---

## CHANGE 2 — Personas and documents

### The feeding rule

**Previous stage document + chat thread.** Nothing else. Brainstorm feeds product planning; product spec feeds engineering planning; engineering spec feeds proto.

Uploads attach to the current mode's document as source material. Record which upload informed which claim — the audit reference must be able to distinguish a founder's belief from a source's statement.

### Document scale — length by purpose

| Document | Length |
|---|---|
| Research knowledge base | Uncapped — grows with evidence |
| Product spec | 2–3 pages. Unambiguous, readable before an engineering session |
| Engineering spec | **As long as the design requires. Do not compress.** |
| Audit reference | Uncapped, append-only |

The engineering spec is proto's input. Under-specifying it causes inconsistent implementation, missed edge cases and rework — the expensive failure this whole chain exists to prevent. Length there is correct.

**The constraint is no padding, not brevity.** A document long because the system is complex is right. A document long because it restates the one above it is not.

**Slack limits apply to in-thread summaries only.** Attach full documents as files, using the pattern already built for research reports — and note the bug found there: the attachment must be the full document, not a second rendering of the summary.

### The personas, defined by refusal

Each refusal **must name what would unblock it**. No dead ends.

**Brainstorm — co-founder.**
Refuses an unfalsifiable claim. Suggests the threshold or named alternative that would make it testable. Engages with business and product depth. Agent-initiated surface search permitted when a specific fact is missing.
*Produces:* research knowledge base — assumptions, evidence, what's known and unknown.

**Product planning — PM.**
Refuses a feature without a user, a job to be done, and a success metric.
**Also refuses to prescribe technical implementation** — over-specifying in a PRD limits engineering creativity and may propose suboptimal solutions.
*Produces:* product spec — vision, goals, user stories, success criteria, scope tradeoffs. Solution-level, never technical.

**Engineering planning — engineer.**
Refuses a design without stated failure modes and a cost-of-development estimate. Balances resilience against build cost explicitly.
**Refuses to reopen product decisions** — mixing requirements with implementation creates confusion about who owns what.
*Produces:* engineering spec — architecture, data models, API contracts, edge cases. Under-specifying here causes inconsistent implementation and rework, so this is the one document that earns detail.

**Proto — builder.**
Refuses to build without an engineering spec. The only persona allowed to write code. Retains the autonomous build loop and the five-touch cap.

Personas must be distinguishable by what they will not accept, not by tone. Tone alone collapses them into one voice.

### Mode exit

**The founder decides a document is ready by moving on.** No completeness judgement by the bot.

If a mode is exited with an empty or near-empty document, warn — do not block.

---

## CHANGE 3 — Missing and stale documents

### Missing (skipped stage)

Entering a mode whose input document doesn't exist:

> Engineering planning normally works from a product spec. There isn't one.
> I can generate a draft from the research base and this thread, or you can switch to product planning and write it yourself.
> **[ Generate it ]  [ Switch to product planning ]**

On consent, generate, **mark it clearly as auto-generated at the top**, post a summary in-thread, and attach the full document. The founder must be able to see what they're building on without opening a file.

### Stale (upstream changed)

When an upstream document changes, diff it against downstream documents and classify:

| Intensity | Meaning | Action |
|---|---|---|
| **Cosmetic** | Wording only, no downstream effect | Note it. Do nothing. |
| **Additive** | New requirement, existing decisions still valid | Append a "needs coverage" note to the downstream section |
| **Contradictory** | A downstream decision rests on something that changed | Mark the specific section stale — not the whole document |

Entering a mode with stale downstream sections, or invoking proto against them:

> The product spec changed since this engineering spec was written. Two sections are contradictory, one is additive.
> I can regenerate just the stale sections and show you the diff, or you can update them yourself.
> **[ Regenerate stale sections ]  [ I'll do it ]**

### The rule

**Generate what's missing. Regenerate only what's stale. Always show it before it takes effect. Never silently overwrite what the founder wrote.**

Regeneration is section-scoped — untouched decisions survive. Never auto-rewrite a whole document a founder authored.

---

## CHANGE 4 — Audit and the reference doc

### Audit is entered, not triggered

Audit runs only when the founder enters audit mode and asks. It is not a gate and does not block any transition.

**One suggestion, before proto** — offered once, ignorable, in the same shape as the surface-search offer. This is the only prompt to audit anywhere in the system.

Audit rules on wherever the idea is, with whatever evidence exists. Thin engineering evidence is itself part of the verdict.

### The reference doc

`ideas/<id>/audit-reference.md`. Append-only, timestamped. Compressed by `flash-fast` every 5 turns, **across all modes**.

**The audit tool reads:** this doc, research reports, raw field notes, `outcomes.md`, graveyard digest. **Never the raw thread.** This preserves D-28 while giving the auditor the reasoning that artifact-only scoping threw away.

### The compressor — the most sensitive prompt in the system

Frame the job as **attributed transcription**, not bias removal.

Record what was claimed, mark whether it came from a retrieved source, a founder's belief, or something a real person said, and keep every specific — numbers, named competitors, named regulations.

**Two failure modes to design against:**

1. **Over-stripping.** An argument containing a fact is not a bias. "Shiprocket X bundles this free so brands won't pay separately" must survive; only the conviction around it goes.
2. **Laundering.** Compression must never upgrade speculation into finding. "We think brands would pay ₹15k" cannot become "brands pay ₹15k." That is fabricated evidence arriving by a new route, and D-33 exists to block it.

**Required in every entry:**
- **Which mode produced it.** Compressed engineering discussion reads differently from business conversation, and the auditor must be able to tell them apart.
- **Citations to the specific `research-<stamp>.md`** a claim draws on.
- **A running header** listing every research pass for the idea — stamp, assumption, evidence basis — so the auditor sees the full evidence set even where the conversation never mentioned a report.
- **Claims that contradict a report the founders have already read**, flagged. Evidence available and set aside is different from evidence not existing, and it is the most common way a founder talks past a kill.
- **Research passes run but never discussed**, flagged. The same failure, quieter.

Append-only. Never rewrite earlier entries; a later contradiction is appended, not resolved. The auditor should be able to see the founders change their mind.

**Verify:** write a deliberately enthusiastic brainstorm run — overclaiming, unsourced numbers, conviction — and show the raw turns beside the compressed entry. Specifics preserved, every unsourced claim marked as founder belief.

---

## CHANGE 5 — Buttons must resolve on tap

The weekly profile diff posts approve and reject buttons; tapping either leaves both rendered, with no confirmation the action landed and both still tappable.

On tap, `chat.update` the message to replace the action block with the outcome — "✅ Applied to profile.md" or "✗ Rejected, profile unchanged" — with a timestamp. Guard against double-taps on a stale message.

**Audit every other button for the same failure:** promote, mount, dismount, extend, take over, stale kill, and the new mode-switch and generate/regenerate buttons. Any button that fires must visibly resolve.

---

## MIGRATION — the existing project

`f05e` has real content across five threads plus `origin-chat.md`.

**Back up `ideas/f05e/` before touching anything.**

1. Consolidate all five stage threads into one project thread, chronologically, preserving attribution and timestamps
2. Generate `audit-reference.md` retroactively from existing brainstorm content and origin chat, using the same compressor
3. Preserve `origin-chat.md`, research reports, field notes and `state.json` untouched
4. Set mode to brainstorm
5. Post a migration note in the consolidated thread

**If consolidation is lossy or Slack's thread structure won't cooperate, stop and report.** I would rather have the old shape intact than a half-migrated one.

---

## DECISIONS

- Supersede D-47 (five stage threads)
- Amend D-28 — the auditor still never reads the raw thread, but now reads the compressed reference doc rather than artifacts alone
- New entry: the mode model, mandatory brainstorm start, the four personas defined by refusal
- New entry: the feeding rule, missing/stale handling, the three diff intensities
- New entry: the audit-reference doc and its two compressor failure modes
- Record that modes are sequential in dependency but not in gating — this reverses the earlier "modes do not gate each other" framing and the reversal should be visible

---

## Verification

- A new project starts in brainstorm and cannot start elsewhere
- Each persona refuses its defined case **and names what would unblock it**
- PM refuses to specify implementation; engineer refuses to reopen product decisions
- Entering engineering planning with no product spec offers generate-or-switch, never proceeds silently
- An upstream change classifies correctly across all three intensities
- Regeneration is section-scoped; an untouched section survives verbatim
- An auto-generated doc is marked as such and summarised in-thread
- A long engineering spec attaches in full — verify the attached file's word count matches the generated document, not the summary
- The audit reads the reference doc and never the raw thread
- The compressor preserves specifics and marks unsourced claims
- Every button resolves visibly on tap
- `f05e` migrates without loss
