# DECISIONS

**Version 3.0.** Supersedes v2.0 (harness and control surface changed) and v1.0 (which described a software delivery pipeline — see D-24).

**Purpose.** The architect's memory, externalized. Every agent session starts cold. Without this file, settled questions get re-argued or silently overturned.

**How to use it.** Before changing anything structural, find the entry. If the revisit condition has been met, reopen it. If not, the decision stands — including against your own judgement that something better exists. If you think an entry is wrong and no revisit condition applies, say so to the founders rather than acting.

**How to extend it.** New decisions get a new entry in the same format. Never delete an entry; mark it superseded and point to what replaced it.

**Prices and benchmarks:** as of 21 August 2026. Verify before anything becomes load-bearing.

---

## Layer 0 — Purpose

### D-24 · This is a validation mill, not a delivery pipeline

**Decision.** The system exists to find out whether an idea is worth having. `capture → brainstorm → research → audit → prototype ⇄ touches`. Most passes end in the idea dying.

**Superseded.** v1.0 was a six-stage delivery pipeline: frozen OpenAPI contracts, Spectral validation in CI, lock-then-fan-out spec authoring, cross-model code review, overnight production builds. All removed.

**Why it was wrong.** Contract discipline protects against divergence across a team and a codebase you maintain. Three founders validating ideas have neither, and most of what they build should be discarded within a week.

**The metric.** Cost per idea killed, not cost per token.

**Do not reintroduce delivery rigour** without an explicit decision that something is being built for users.

---

### D-33 · Research merges web and field evidence

**Decision.** Every research pass gathers published sources *and* asks the founder what they've heard from real people. Where field evidence is absent, the pass outputs three questions that would resolve the assumption and who to ask.

**Enforcement: web-only evidence caps the audit verdict at `narrow`.** `proceed` requires field evidence.

**Why.** Desk research is the weakest form of startup validation. What kills or confirms an early idea is talking to people who would pay. The original design built an elaborate research apparatus and never mentioned customer conversations — a significant omission, caught by the founders.

**What the mill is for.** Making the founders ready for those conversations and sharpening what comes back, not substituting for them.

**Revisit when:** never, without an explicit decision to lower the evidence bar.

---

### D-25 · Three founders, $100/month total

**Decision.** $100/month all-in, not per founder. Roughly five research passes and five audits per founder per month.

**Why it binds.** Capability per founder fell by a third when the third founder joined and the ceiling didn't move. State that plainly rather than quietly thinning estimates.

**Revisit when:** the ceiling moves, or two months of actual spend show the estimates wrong.

---

### D-35 · English only

**Decision.** Captures, profiles, research and audit all operate in English. No multilingual handling built.

**Founders' call.** Recorded because it is a real assumption that would otherwise sit unexamined — three founders in India could plausibly need Hindi, Tamil or code-switched capture.

**Revisit when:** captures start arriving in other languages and the profiles degrade.

---

## Layer 1 — Infrastructure

### D-03 · Pi as the harness

**Decision.** Pi (`@earendil-works/pi-coding-agent`), MIT licensed. Provider access through `pi-ai`. Slack control surface is custom-built (see D-39) — not through `pi-chat`.

**Supersedes:** dsh (DeepSeek Harness), which held this slot for the first two versions.

**Why the switch.** dsh was accepted as a given in the opening message and never compared against alternatives — a real gap, since every model choice was interrogated repeatedly while the layer beneath them went unexamined. On comparison Pi wins on the axes that matter here:

- **Maturity.** 11.5K+ GitHub stars, 3.17M+ monthly npm downloads, new model support within hours — against a developer preview warning in capital letters about breaking changes between release candidates.
- **Four runtime modes.** Interactive TUI, `pi -p "query"` with `--mode json` for scripts, RPC over stdin/stdout for non-Node integrations, SDK embedding. Stage runners want print/JSON; the bot wants RPC. Both first-class.
- **20+ providers** through one unified API including Anthropic, Google Gemini and Vertex, and OpenRouter.

**Correction (26 August 2026): the `pi-chat` claim was wrong.** The original comparison listed *"`pi-chat` exists — Slack/chat automation on the same foundation"* as a deciding factor. That claim traces to Pi's own README, which is inaccurate — the error was propagated from upstream docs, not invented at this layer. The actual `earendil-works/pi-chat` project bridges Discord and Telegram only; it has never supported Slack. Third-party Slack bridges for Pi do exist (`comsysto/pi-slack-bridge`, `tintinweb/pi-messenger-bridge`) but were evaluated and rejected as a fit — see D-39. Removing this bullet changes the count of deciding factors but not the outcome: Pi still wins on maturity and runtime-mode fit alone, and D-06's sandboxing cost was already priced in independent of the Slack question.

**Second-order benefit retained.** Model-agnosticism makes cloud credits exploitable without lock-in — you can spend Google credits on Gemini for two years and leave when they run out.

**Cost of the switch:** see D-06. Pi ships no permission system.

**Revisit when:** Pi's security posture changes materially, or a maintained harness ships equivalent extensibility with sandboxing built in.

---

### D-06 · Sandboxing is built, not inherited

**Decision.** Working prototypes execute in a Docker container: no host mount beyond a scratch directory, no credentials in the environment, network egress allowlisted.

**Supersedes** the v1/v2 rule relying on dsh's bwrap + Landlock fail-closed enforcement.

**Why this is now necessary.** Pi has no built-in permission system for filesystem, process, network or credential access, and runs with the full permissions of the launching user unless containerized. Pi documents three patterns — Gondolin micro-VM, Docker, OpenShell. Docker is the pragmatic choice on a 2GB box.

**Why the risk is acceptable.** Under D-24 most prototypes are landing pages and markdown; working prototypes are occasional and small. The blast radius shrank when the design did. Under v1.0's unattended overnight production builds this trade would not have been acceptable.

**Non-negotiable.** No credentials reachable from the prototype container. An agent-written script that can read the Fable API key is the failure mode that turns a $24/month line into a four-figure one.

---

### D-05 · Slack as the control surface

**Decision.** Slack, via a custom Bolt-based bot (see D-39). Not Telegram.

**Supersedes** the v1/v2 Telegram design, which was chosen in a single line and then survived eight revisions unexamined.

**Why.** Slack handles three-user structure properly: DMs for private captures, shared channels for brainstorm output, threads for research reports and their audit verdicts.

| Surface | Use |
|---|---|
| DM to bot | Private captures, per founder |
| `#mill` | Brainstorm, cross, blindspot |
| `#research` | Reports and audit verdicts, threaded |
| `#graveyard` | Kill verdicts |

**Attribution is not optional.** Every capture and command is attributed to its founder; attribution drives profile routing.

**Improvement over the previous design.** dsh headless failed closed on approvals with no way to route them to a phone — recorded in v2 as an unfixable constraint. A Slack bot that posts and waits removes that constraint.

**Correction (26 August 2026).** The original text here read *"`pi-chat` targets Slack natively — the plumbing exists rather than being written."* That was wrong — see D-03's correction and D-39. The choice of Slack over Telegram stands on its own merits (the three-user structure argument above) independent of whether the plumbing was pre-built.

---

### D-34 · Droplet retained; GitHub Actions rejected

**Decision.** Keep the VPS. Do not move scheduled research to CI.

**Considered because** only research runs unattended, and a cron job against a git repo is what Actions does for free — which would have deleted the droplet, hardening, Tailscale, and $12/month.

**Rejected on:** no persistent sandbox for working prototypes, and debugging a failed CI job from a phone is worse than SSH. Founders' call.

---

### D-01 · Host sizing

**Decision.** 2GB RAM, 1–2 vCPU, 4GB swap. DigitalOcean BLR1 as built.

**Why 2GB.** No production builds under D-24. Swap converts an OOM kill into a slow install, acceptable for throwaway work.

**Cheaper option, not yet taken.** Hetzner CX22 gives 4GB for roughly $4.10 against $12. No India datacentre — 130ms from Germany, ~60ms Singapore — irrelevant for a Slack-driven control plane running unattended jobs. Worth roughly five extra audits a month.

**Rejected: Oracle Always Free** (4 ARM OCPU, 24GB, forever). Disk reads at 55 MB/s against Hetzner's 2.52 GB/s, and the prototype bottleneck is disk-bound package installs. Indian debit cards frequently rejected at signup; ARM capacity often unavailable; idle instances reclaimed.

**Revisit when:** healthcheck reports memory pressure more than twice a month, or the budget needs headroom.

---

### D-02 · Abacus.AI rejected

**Decision.** Not used, in any capacity. Founders' call, on the open-infrastructure principle, not capability.

**For the record** it fit the functional requirements well — cron-scheduled always-on execution, terminal access, messaging-platform presence, multi-provider routing at $10–20/month.

**Do not re-propose.** The objection was principled; better pricing or features do not reopen it.

---

### D-04 · Tailscale for access, nothing public

**Decision.** SSH over Tailscale. No inbound ports. No web UI exposed.

**Simplified from v2.** Pi is CLI-first and the control surface is Slack, so there is no web UI to protect — Tailscale now serves debugging access only.

---

## Layer 2 — Models

### D-08 · Gemini 3.7 Flash is the workhorse

**Decision.** Brainstorm, research, profile evolution, prototype, touches, and audio capture. Everything except the audit gate and bulk mechanical work.

**Why.** Intelligence Index 56 at $0.75/$3.75 — close to Fable 5's 62.1 at a fraction of the cost. AutomationBench 30.4% against Claude Sonnet 5's 10.7%. Token-efficient: 64M generated against a 71M median. US jurisdiction, resolving D-17 without hosting workarounds.

**Provenance.** A founder identified this model. Released 13 August 2026, it had not propagated into the value-ranking sources being consulted, so the initial design missed it. Leaderboard-derived recommendations lag reality by weeks.

**Revisit: 31 December 2026.** Introductory pricing expires; rates double to $1.50/$7.50 — roughly a $20/month increase, material at $100. Re-run the comparison in December, not January.

---

### D-36 · No separate transcription service

**Decision.** Voice captures go straight to Gemini 3.7 Flash, which accepts audio natively.

**Why.** The v2 budget carried a transcription line for a capability the workhorse model already has. One fewer vendor, one fewer failure point, ~$3/month back.

---

### D-10 · Fable 5 at the audit gate only

**Decision.** One use: the audit between research and prototype. Never from a background job, never a profile default.

**Why here.** One pass, high leverage, guarding founder attention. A `kill` at $1.60 saves a prototype cycle and the days that follow it.

**Placement history.** Earlier designs put Fable at a synthesis stage, then at a pre-research gate. A founder moved it to post-research: auditing before research means auditing a hunch; auditing after means the gate sees evidence, so both verdicts become defensible.

**Design history, recorded because the failure recurred.** The first architecture spread Fable across strategy, spec and build. Corrected. The second removed it entirely — reacting to criticism rather than re-reasoning. If a future session finds itself either spreading Fable across stages or arguing it out of the gate, that is the known oscillation, not new insight.

**Cost discipline.** The audit reads the research report, not the raw corpus. Reading the corpus triples cost with no demonstrated gain.

---

### D-09 · Opus 5 removed · SUPERSEDED

Held ideation, contract authoring and semantic review in v1.0. Under D-24 there is no contract stage and the audit is the only decision point.

**Revisit when:** the ceiling rises enough to afford a middle tier between $0.75 and $10 input.

---

### D-11 · Kimi K3 removed · SUPERSEDED

Held the research lead on BrowseComp 91.2%. At roughly $3/$15 it is 4× Flash's cost — one K3 pass costs four Flash passes. Triaging many ideas, four shallower passes beat one deep one.

**Revisit when:** research quality proves the binding constraint on kill-rate accuracy.

---

### D-12 · MiniMax M3 for mechanical work only

**Decision.** Bulk scrape, classify, summarise. Not a reasoning stage.

**Why.** $0.30/$1.20 with $0.06 cache reads, Intelligence 44.4, GPQA 92.9, 1M context. One tracker ranks its agentic category weakest at #103 while multimodal and grounded work ranks #27 — hence mechanical work rather than driving loops.

---

### D-13 · Smaug-Agentic excluded

**Decision.** Not used. Founders' call.

**For the record:** benchmark deltas over Kimi K3 are marginal and vendor-run against reference figures Abacus did not re-run. The behavioural claim was the interesting part — p99 reasoning at 0.62× base on SciCode, runaway reasoning suppressed. Blockers regardless: 2.8T MoE makes hosting doubtful; kimi-k3 licence, not MIT or Apache.

---

### D-07 · DeepSeek removed

**Decision.** Not used at any stage.

**Why.** The 16 August 2026 price increase moved V4 Pro to $0.66/$1.98 off-peak and $1.32/$3.96 peak — 2–5× prior rates — removing the cost rationale. Never competitive on reasoning (Intelligence 31.9, GPQA 71.7).

**Void.** An earlier design scheduled background runs into Indian evenings to catch off-peak half-rates. That constraint no longer applies.

---

### D-14 · No cross-model benchmarking programme

**Decision.** No golden eval set, no re-benchmarking cadence. Selection rests on published benchmarks and founder judgement.

**Not affected.** The research citation re-check (D-20) and per-stage cost instrumentation — correctness and telemetry, not model evaluation.

---

### D-15 · OpenRouter as failover only

**Decision.** Direct provider APIs primary; OpenRouter registered as secondary through `pi-ai`.

**Original rationale, expired.** Going direct preserved DeepSeek's off-peak discount; D-07 removed DeepSeek from the critical path.

**Standing rationale.** 5.5% on credit purchases with a $0.80 minimum, punitive on small top-ups. Direct also gives provider-console spend caps, the primary defence in D-23.

---

## Layer 3 — The loop

### D-26 · Profiles record how you fail, not what you believe

**Decision.** Each `profile.md` records failure patterns: what the founder over-weights, which frames they default to, what they've killed and what killed it.

**Why.** A profile that learns what you believe and feeds it back builds an echo chamber — the opposite of the stated purpose. As failure patterns, it becomes ammunition for the orthogonal angle rather than a mirror. The difference between "you'd like this" and "you always assume distribution is the easy part — this idea has the same hole."

**`graveyard.md` is what sharpens it.**

---

### D-30 · Profile evolution is weekly and human-gated

**Decision.** A Sunday job proposes a **diff** to each founder's DM for approval. Never auto-applied. Each founder hand-corrects their own profile monthly.

**Why.** The profile shapes every brainstorm downstream. Drift is gradual enough that nobody notices until outputs have gone generic.

---

### D-27 · Three-way cross-pollination

**Decision.** `/cross` runs an idea through both other founders' profiles and returns two distinct angles. `/blindspot` attacks from `shared/dynamics.md`.

**Why.** The cheapest genuine outside angle is another founder's priors, not a prompt trick. Convergence on the same objection means it's real; divergence means multiple independent risks.

**Why `/blindspot` exists.** Three founders agreeing feels like validation but usually means shared priors. The shared blind spot needs its own attack surface.

---

### D-31 · Raw captures are private by default · SUPERSEDED

**Decision.** Captures arrive by DM and stay private to that founder. Profiles, `themes.md` and `dynamics.md` are shared.

**Why.** Half-formed thoughts are not always things people want read. Trivial now, awkward to retrofit.

**Superseded by D-38.** All three founders explicitly agreed to open raw captures — the revisit condition below was met.

---

### D-38 · Raw captures are visible to all three founders via the shared repo

**Decision.** Captures still arrive privately by DM — that part of D-31 is unchanged. But under D-21 (git repo as externalized memory), every capture is committed to `minds/<founder>/captures/`, and the repo is shared. Once a capture is pushed, all three founders can read it.

**Why.** All three founders explicitly agreed to this, superseding D-31's private-by-default rule. Recorded here because it is a real change in what "private" means in this system: private at arrival, not private after commit.

**Practical effect.** There is no DM-only, repo-excluded storage tier for captures. A founder who wants a thought to stay unread by the other two should not send it to the bot.

**Revisit when:** never, without an explicit decision to reverse it. If a genuinely private tier is wanted later, it needs new infrastructure (per-founder repo access, or a store outside the shared repo) — not just a documentation change back to D-31.

---

### D-28 · Research is ungated; the audit is the gate

**Decision.** Research runs freely on any hunch. One gate, between research and prototype.

**Why.** At ~$1.50 a pass, research is cheap enough to run on speculation. Gating it would spend a $1.60 audit to protect a $1.50 run.

**Every pass needs a falsifiable assumption** from `/attack`. Without one, research becomes reading around a topic.

**Kill-rate tracking.** Below ~30%, the audit isn't earning its 24% budget share — either the prompt is too permissive or ideas aren't reaching it raw enough.

**The auditor never sees the brainstorm transcript.**

---

### D-20 · Citation verification inside the research pass

**Decision.** The final step re-fetches a sample of cited URLs and confirms they say what the report claims. Claims without a retrieved source are marked `unresolved`, never "likely".

**Superseded:** v1.0's separate verifier pass on a second model — at this budget that doubles research cost.

**Why it survives budget cuts.** Hallucinated validation is the failure mode that actually kills founders.

---

### D-29 · Prototype discipline

**Decision.** `/proto` refuses to run without a named assumption. Prototypes deleted by default. Touches capped at five iterations.

**Why.** The `prototype ⇄ touches` loop has no natural terminator, and it is where validation quietly becomes product development.

**Wanting to keep a prototype is a signal, not a preference.** It means the founders have decided to build — a different conversation with a different budget.

---

### D-16 · Search decoupled from model grounding

**Decision.** A dedicated search API behind a swappable interface. Native grounding not used for bulk work.

**On cost.** Google Search grounding gives 5,000 free requests monthly across Gemini 3.x, then $14 per 1,000 — billed per query the model executes, not per prompt, and one prompt can fan out into several. A ten-search task costs ~$0.14 in grounding against ~$0.11 in tokens.

**On architecture.** Native grounding binds search quality to the model, contradicting D-03's purpose.

**Permitted exception.** The 5,000 free requests on high-value passes, deliberately budgeted.

---

### D-17 · Confidentiality: the ideas are the asset

**Decision.** Prefer non-China hosting where jurisdiction matters. Consider what enters an audit call.

**Why.** DeepSeek's policy states data is stored on servers in China and may be used for training unless opted out. Fable 5 has mandatory 30-day retention with no zero-data-retention option.

**Precedent.** Frontier access can vanish by government order — Fable and Mythos were suspended for 19 days in June 2026 under US export controls. The strongest standing argument for D-03's model-agnosticism.

---

## Layer 4 — Working practice

### D-23 · Spend limits

| Provider | Cap |
|---|---|
| Google — Gemini 3.7 Flash | $60 |
| Anthropic — Fable 5 workspace | $35 |
| MiniMax | $10 |
| Search API | $15 |

**Fable's line is a tripwire.** Gate-only use at ~$1.60/call means a healthy month is $24. Above $35 means something is invoking Fable outside the gate — a D-10 violation, and the cap is how it surfaces.

**Monthly caps do not stop runaways.** The healthcheck polls daily spend and alerts to Slack above ~$8/day. Provider caps are the last line; `max_tokens` and loop iteration ceilings come first.

**Revisit when:** two months of actual data exist, or D-08's December price change lands.

---

### D-32 · Cloud credits deferred

**Decision.** No credit programmes pursued now, beyond whatever Microsoft Founders Hub grants for free.

**Why.** A bare Gmail signup returned $200 in Azure credits — unusable, since nothing here runs on Azure and spending it would mean swapping the entire model allocation. Published figures of $5,000 for bootstrapped founders were already a tightened tier and did not match reality.

**Why deferred, not rejected.** Credits are one-shot per company and typically expire in 12–24 months. Claiming $2,000 in Google credits while spending $30/month wastes most of it.

**Do not incorporate to unlock credits.** Entity structure follows legal and tax needs. Indian incorporation carries MCA registration, a CA on retainer, and annual compliance — real recurring cost against credits drawn down over years.

**Revisit when:** one idea has survived the gate and is being built, and monthly inference spend approaches $200.

---

### D-21 · Git repo as externalized memory

**Decision.** Everything committed: captures, profiles, graveyards, research reports, audit verdicts, decisions. `CLAUDE.md` at root imports this file.

**Why.** No agent session persists. The repo is not documentation *about* the system — it is the only continuous memory it has, and with three founders the only shared substrate.

---

### D-22 · Claude Code as build scaffolding only

**Decision.** Claude Code via Remote Control may execute and test the build. Not part of the running system.

**Why.** Renting a ladder, not pouring a foundation. Remote Control makes outbound HTTPS only and never opens inbound ports, so it works with the deny-all firewall.

**Boundary.** SSH hardening — any edit to `sshd_config` or restart of the ssh service — is done by hand, never by an agent.

---

### D-37 · Run the loop manually before building it

**Recommendation, not yet decided.** Two weeks of three founders, a shared doc, and one paid audit each, before any infrastructure exists.

**Why it is here.** A week of setup and $100/month is itself an idea that has not been through the mill. The honest prediction is that capture and `/blindspot` get used constantly while the research apparatus gets used twice — and that would change what gets built first.

**Status:** raised twice, not answered. Left open deliberately.

---

### D-39 · Custom Bolt bot for Slack, not a pi-chat bridge

**Decision.** The Slack control surface is a small custom bot (Slack Bolt SDK, Socket Mode) that shells out to `pi -p --mode json` per message, not an installed Pi extension.

**Why this came up.** D-03 and D-05 originally credited `pi-chat` with Slack support — that claim was wrong (see both entries' corrections). Real Slack bridges for Pi exist once the actual ecosystem was checked: `comsysto/pi-slack-bridge` (a Slack-focused fork) and `tintinweb/pi-messenger-bridge` (its multi-transport parent, Telegram/WhatsApp/Slack/Discord/Matrix). Both were read as reference implementations for their Slack block-splitting and message-length handling before writing this bot's equivalent — neither was adopted.

**Why not adopt one.** Both bridges are built for a different problem: **remote control of one person's own Pi terminal session**, not a multi-tenant application. Their auth model makes this explicit — a single trusted Slack user claims the bridge via a 6-digit challenge code, and every other user is ignored until that claim is manually released (`/slk-bridge releaseclaim` or `/msg-bridge revoke`). That is the right model for "let me drive my laptop's Pi session from my phone." It is the wrong model for three founders who each need to be simultaneously trusted and routed to their own `minds/<name>/` directory (D-31/D-38's attribution requirement). Retrofitting three-way simultaneous trust onto a single-claim architecture is more work than writing a stateless allowlist against Slack's verified `user_id` — see D-40.

**What was reused.** Not code — the design patterns. Slack Block Kit's markdown block technically allows up to 12,000 characters but both references stay conservatively under ~6,000 and split on markdown-aware boundaries (headers, then paragraphs/sentences, then raw) before falling back to hard truncation. That splitting strategy is reused in this bot's own message-formatting code.

**Revisit when:** the founder base grows beyond three and a single-tenant-per-instance model with one bridge process per founder becomes viable, or one of the reference bridges adds native multi-tenant trust.

---

### D-40 · Slack auth: verified user_id allowlist, no secondary login

**Decision.** Founder identity comes from Slack's verified `user_id` in the event payload — nothing else. The bot holds a static, explicit map of the three founders' Slack user IDs to their `minds/<name>/` directory. A message from a `user_id` not on the map is dropped silently: no error reply, no capture written, no log visible to the sender.

**Why no passphrase or secondary login.** Slack has already authenticated the human before the event reaches the bot. A passphrase or code-based claim step (the pattern both D-39 reference bridges use) adds a second, weaker credential on top of one that's already trustworthy, and it's the wrong shape for three founders who should all be trusted from the first message, permanently, not one at a time.

**Why silent-drop, not an error reply.** An error message to an unrecognized `user_id` confirms to that sender that the bot exists and is listening — surface area this system doesn't need. Founders only ever touch Slack (no SSH, no keys, no server access), so the allowlist is the entire access-control boundary; it fails closed by default (unknown IDs produce no effect) rather than failing open or leaking its own existence.

**Revisit when:** a fourth founder joins, or Slack's `user_id` stops being a reliable verified identity (e.g., a shared-workspace or guest-account edge case surfaces).
