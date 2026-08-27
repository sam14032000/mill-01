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

### D-03 · Pi as the harness · SUPERSEDED

**Superseded by D-43.** Pi was uninstalled and never wired into the running system as anything more than orchestrator scaffolding — see D-43 for the full record of why the harness choice turned out not to matter. The dsh-vs-Pi comparison below is kept, not deleted: the reasoning that produced it (compare, don't inherit a default; check upstream claims before building on them) is still instructive even though its conclusion no longer drives anything.

**Original decision.** Pi (`@earendil-works/pi-coding-agent`), MIT licensed. Provider access through `pi-ai`. Slack control surface is custom-built (see D-39) — not through `pi-chat`.

**Supersedes:** dsh (DeepSeek Harness), which held this slot for the first two versions.

**Why the switch.** dsh was accepted as a given in the opening message and never compared against alternatives — a real gap, since every model choice was interrogated repeatedly while the layer beneath them went unexamined. On comparison Pi wins on the axes that matter here:

- **Maturity.** 11.5K+ GitHub stars, 3.17M+ monthly npm downloads, new model support within hours — against a developer preview warning in capital letters about breaking changes between release candidates.
- **Four runtime modes.** Interactive TUI, `pi -p "query"` with `--mode json` for scripts, RPC over stdin/stdout for non-Node integrations, SDK embedding. Stage runners want print/JSON; the bot wants RPC. Both first-class.
- **20+ providers** through one unified API including Anthropic, Google Gemini and Vertex, and OpenRouter.

**Correction (26 August 2026): the `pi-chat` claim was wrong.** The original comparison listed *"`pi-chat` exists — Slack/chat automation on the same foundation"* as a deciding factor. That claim traces to Pi's own README, which is inaccurate — the error was propagated from upstream docs, not invented at this layer. The actual `earendil-works/pi-chat` project bridges Discord and Telegram only; it has never supported Slack. Third-party Slack bridges for Pi do exist (`comsysto/pi-slack-bridge`, `tintinweb/pi-messenger-bridge`) but were evaluated and rejected as a fit — see D-39. Removing this bullet changes the count of deciding factors but not the outcome: Pi still wins on maturity and runtime-mode fit alone, and D-06's sandboxing cost was already priced in independent of the Slack question.

**Second-order benefit retained.** Model-agnosticism makes cloud credits exploitable without lock-in — you can spend Google credits on Gemini for two years and leave when they run out.

**Cost of the switch:** see D-06. Pi ships no permission system.

**Revisit when:** Pi's security posture changes materially, or a maintained harness ships equivalent extensibility with sandboxing built in. **Moot as of D-43** — there is no harness in the running system for a revisit to reinstate a replacement into.

---

### D-06 · Sandboxing is built, not inherited

**Decision.** Working prototypes execute in a Docker container: no host mount beyond a scratch directory, no credentials in the environment, network egress allowlisted.

**Supersedes** the v1/v2 rule relying on dsh's bwrap + Landlock fail-closed enforcement.

**Why this is now necessary.** Pi has no built-in permission system for filesystem, process, network or credential access, and runs with the full permissions of the launching user unless containerized. Pi documents three patterns — Gondolin micro-VM, Docker, OpenShell. Docker is the pragmatic choice on a 2GB box. **This decision doesn't depend on Pi's removal (D-43).** `sandbox.js` executes model-generated code directly, with no harness in between either way — the risk this entry addresses (arbitrary generated code running with real permissions) was never actually specific to Pi, only originally framed in Pi's terms because Pi was the assumed executor at the time this was written.

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
| `#mill-ideas` | Brainstorm, cross, blindspot |
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

**Simplified from v2.** The control surface is Slack and nothing in the stack (the custom bot, LiteLLM) exposes a web UI, so there is nothing to protect — Tailscale serves debugging access only.

---

## Layer 2 — Models

### D-08 · Gemini 3.7 Flash is the workhorse

**Decision.** Brainstorm, research, profile evolution, prototype, touches, and audio capture. Everything except the audit gate and bulk mechanical work.

**Why.** Intelligence Index 56 at $0.75/$3.75 — close to Fable 5's 62.1 at a fraction of the cost. AutomationBench 30.4% against Claude Sonnet 5's 10.7%. Token-efficient: 64M generated against a 71M median. US jurisdiction, resolving D-17 without hosting workarounds.

**Provenance.** A founder identified this model. Released 13 August 2026, it had not propagated into the value-ranking sources being consulted, so the initial design missed it. Leaderboard-derived recommendations lag reality by weeks.

**Revisit: 31 December 2026.** Introductory pricing expires; rates double to $1.50/$7.50 — roughly a $20/month increase, material at $100. Re-run the comparison in December, not January.

**Amendment (26 August 2026): the cost model assumed visible output tokens.** It didn't. Gemini 3.x bills internal reasoning as output tokens, and defaults to `thinking_level: "high"` when the caller doesn't specify one — found while building `/attack`, where every call was taking 90-180s+ before a false trail (below) was cleared and the real cause turned out to be an API not enabled on the Google Cloud project, unrelated to thinking level at all. Once that was fixed, a controlled comparison confirmed `thinking_level` genuinely works: a trivial prompt cost 74 reasoning tokens at `low` against 102 at `medium`, and the full `/attack` prompt completed in 15s at `low` with 676 reasoning tokens against 617 visible ones — reasoning tokens roughly matching or exceeding visible output on a real prompt, not a rounding error.

**Fix.** `~/stack/litellm/config.yaml` splits the single `flash` entry into two: `flash-fast` (`thinking_level: low`) for interactive commands, and `flash` (`thinking_level: medium`) kept for research. Routing: `/attack`, `/think`, `/cross`, `/blindspot`, `/themes`, `/proto` use `flash-fast`; `/test`'s research pass uses `flash`. **Never leave `thinking_level` unspecified** — that's the default-to-`high` trap this amendment exists to close. `max_tokens` is at least 4096 everywhere reasoning is enabled, since thinking tokens draw from the same output budget as the visible answer and a low cap can leave nothing for the answer at all. `drop_params: false` is set per-entry for both flash models, not globally — confirmed via debug tracing that LiteLLM's default `drop_params: true` was silently discarding `thinking_level` before this fix, though that turned out not to be the actual root cause of the latency (see below).

**The false trail, recorded because it's the more durable lesson than the fix itself.** A disabled Google Cloud API surfaced as latency, not an error — every call eventually returned 200 successfully, just slowly, which made it look like a behavioral or configuration problem rather than an access problem. Three layers of plausible explanations got built and individually disproven before the real cause was found: (1) suspected a hung client/proxy connection — ruled out by testing DNS, TCP+TLS, and Redis from inside the LiteLLM container directly, all sub-100ms; (2) suspected `thinking_level` wasn't reaching Gemini at all — confirmed via debug logs that LiteLLM's Gemini request-builder was in fact dropping the parameter from the outbound `generationConfig` regardless of `drop_params`, a real but *secondary* bug, not the cause of the slowness; (3) attempted a Gemini pass-through route to bypass LiteLLM's param mapping entirely, and even that was slow, which should have been the tell — pass-through has no LiteLLM-side param translation to blame, so ruling out LiteLLM as thoroughly as step 2 did should have pointed at Google's side sooner. The fix came from a test *outside* the stack entirely, in AI Studio, which is the general lesson: when every layer you've checked reports healthy and the symptom persists, the next check should leave the stack, not go deeper into it.

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

### D-12 · MiniMax M3 for mechanical work only · SUPERSEDED

**Superseded by D-46.** The `mechanical` tier was removed entirely in the projects phase — it was only ever wired up for document indexing (Part 17), never had a virtual key provisioned, and wasn't worth a fourth provider to rotate. Original entry kept below.

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

**Decision.** Direct provider APIs primary; OpenRouter registered as secondary through LiteLLM's own `model_list` (not `pi-ai` — see D-43, that layer never existed in the running system). Not yet built: no OpenRouter entry exists in `~/stack/litellm/config.yaml` as of this build.

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
| Search API | $15 |

(MiniMax's $10 line removed — provider dropped, D-46.)

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

**Decision.** The Slack control surface is a small custom bot (Slack Bolt SDK, Socket Mode), not an installed Pi extension.

**Correction (see D-43): it doesn't shell out to `pi -p --mode json` either.** That was the plan when this entry was written, but the bot as actually built calls LiteLLM's `/chat/completions` directly over HTTP (`ops/slack-bot/llm.js`, `audit-llm.js`) — Pi was never wired into the request path at all, not even in the "print mode per message" form this entry originally described. Caught while building `ops/conformance.py`'s C-18 check, which found zero `pi -p` invocations anywhere in `ops/`. The rest of this entry's reasoning (why not adopt a reference bridge) holds regardless of which HTTP client sits behind the bot.

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

---

### D-41 · The command layer was unspecified until docs/COMMANDS.md

**Decision.** `docs/COMMANDS.md` is now the application spec for what each slash command does — prompt content, context assembly, file writes, failure handling — and is imported into `CLAUDE.md`.

**Why this needed recording.** Every design pass from v1.0 onward described `/think`, `/cross`, `/blindspot`, `/attack`, `/test`, `/audit`, `/proto` and `/themes` by name and by what they were *for* (runbook.md Stages 2–6), but never by what a session should actually send to a model or write to disk. That gap was invisible as long as `pi-chat` was believed to supply the control surface wholesale — D-03's original text called it *"the entire control surface is a chat bot."* Once D-39 established that no such package exists for Slack, the missing layer became load-bearing: something has to generate these prompts, and until `docs/COMMANDS.md` existed nothing said what.

**Consequence, not a new decision.** This isn't a new design choice so much as the debt coming due on D-03's incorrect premise. Recorded here so a future session doesn't wonder why the command layer looks hand-specified while everything above it in the stack was chosen by comparison and benchmark.

**Build order (per docs/COMMANDS.md, build-guide.md Part 9b):** `/attack` first, since it's the only command that creates an idea and every other command operates on one that already exists. Then `/think`, `/cross`, `/blindspot`, `/themes` — the brainstorm-shaped commands, lower stakes individually. Then `/test`, which drives the research pass. `/audit` last, deliberately — its JSON validation and the D-33 web-only-caps-at-narrow enforcement (C-07 in COMMANDS.md) is the most load-bearing code in the system, and everything before it exists to feed that gate correctly.

**Revisit when:** never — this entry stays as the record of how the gap arose, even after the spec is fully implemented.

---

### D-42 · Captures are append-only, never edited after commit

**Decision.** Once a capture is written to `minds/<founder>/captures/YYYY-MM-DD.md` and committed, it is never edited or deleted. Corrections, retractions, or second thoughts are new captures, not changes to old ones.

**Why this needed its own entry.** The rule itself was never in question — `runbook.md` Stage 1 ("committed raw, **never edited**") and `CLAUDE.md`'s Conventions ("Commit captures raw and unedited") both state it plainly and have since early versions. What was missing was a D-number to point at. `docs/EVAL.md`'s conformance check C-20 cited `D-25` for this rule — D-25 is "Three founders, $100/month total," unrelated to captures — a mis-citation caught while implementing telemetry against `EVAL.md`. Rather than leave C-20 pointing at nothing or something wrong, this rule gets the entry it should have had from the start.

**Why append-only matters here specifically.** Captures are the raw material profiles and brainstorms are built from (D-26). If they could be edited after the fact, "what a founder actually said on a given day" stops being a fixed thing the system can build trust on — profile evolution (D-30) and any future retrospective on why an idea died would be reasoning about a moving target.

**Revisit when:** never, without an explicit decision that some class of correction needs a different mechanism than a new capture.

---

### D-43 · Pi removed — the harness choice was moot

**Decision.** Pi uninstalled entirely (`npm uninstall -g @earendil-works/pi-coding-agent`). Nothing in the running system invokes it. The architecture that actually exists is LiteLLM as the model-agnostic gateway plus a custom Slack Bolt bot that calls LiteLLM's `/chat/completions` directly over HTTP — no harness layer between them.

**Why this is correct, not a regression.** D-03 chose Pi for three things: model-agnosticism (D-17's confidentiality argument — frontier access can vanish by government order, so don't be locked to one provider), a Slack control surface, and prototype execution. All three turned out to be supplied elsewhere, independent of Pi:

- **Model-agnosticism** is what LiteLLM's `model_list` already does — one proxy, swap `litellm_params.model` per entry, no application code cares which provider is behind `flash`, `audit`, or `mechanical`. This was true from Part 7 onward; Pi was never the layer doing this work.
- **The Slack control surface** was never `pi-chat` to begin with (D-39's correction: that package bridges Discord/Telegram only, never Slack) — it's a bespoke Bolt bot, built without Pi in the loop.
- **Prototype execution** is Part 10's Docker sandbox (`~/stack/sandbox/run.sh`), which runs generated code directly in a locked-down container. It never shelled out to Pi either.

Once those three jobs were traced to their actual owners, there was no fourth thing left for a harness to do. `ops/conformance.py`'s C-18 check (built to verify "Pi is never invoked outside its container for working prototypes," per D-06) surfaced this directly: grepping the entire `ops/` tree for any `pi -p`, RPC, or `spawn`/`execFile` call to `pi` found zero matches, anywhere, not just outside the container. The check the whole time was testing whether a thing was doing what it was never actually doing.

**What this means for D-03's comparison.** The dsh-vs-Pi reasoning (maturity, runtime modes, provider count) was sound *if* something in this system were going to shell out to a harness. Nothing does. That's not a flaw in the comparison — it's that the question "which harness" stopped being the right question once LiteLLM and a plain HTTP client turned out sufficient for every job Pi was being evaluated for. Recorded as moot, not wrong.

**Cost of keeping Pi installed with no job.** None functional — it wasn't in any request path — but it was a dependency and an attack-surface line with no offsetting benefit, and its presence in `docs/build-guide.md`/`CLAUDE.md`/`runbook.md` was actively misleading about what the running system does, which is its own kind of cost (see the drift convention this file's header describes). Removed for that reason as much as for tidiness.

**Revisit when:** never, without an explicit decision that some future stage needs agentic tool-use, multi-step planning, or filesystem/process access beyond a single model call plus the existing Docker sandbox — the shape of job a harness is actually for, and the shape nothing in this system currently has.

---

### D-44 · A wedged Slack connection must become a dead process

**Decision.** `ops/slack-bot/socket-health.js` monitors the Socket Mode connection and calls `process.exit(1)` — letting systemd's `Restart=always`/`RestartSec=10` rebuild it — on any of: websocket pong stale >90s, >3 consecutive pings with no pong, or no inbound Slack event for 15 min *and* a live `auth.test` probe failing. It also maintains `~/logs/mill-chat.heartbeat` (rewritten every inbound event and every 60s), which `ops/healthcheck.sh` alerts on when stale.

**Why this needed recording.** On 2026-08-27 the box rebooted and the bot reconnected into a half-open WebSocket. The process stayed `active` for ~5 hours: inbound `message.im` events were silently dropped (captures written by founders in that window are lost — Slack does not redeliver `message` events indefinitely) while Slack retried slash-command deliveries, producing duplicate `#mill-ideas` posts. `Restart=always` never fired because the process never exited. `@slack/socket-mode`'s own auto-reconnect logs the pong failure but did not recover here.

**The principle.** For a single-process, phone-only-operated system with no human watching logs, "process alive but not doing its job" is a worse failure mode than "process dead," because only the second one triggers recovery. Health checks that can't distinguish the two are close to useless. Every long-running component should convert its own unrecoverable-but-silent states into a non-zero exit, and emit a heartbeat something else can alert on.

**Revisit when:** the thresholds prove wrong in practice (spurious restarts on a healthy-but-idle connection, or a real wedge that slips past all three triggers) — tune via the `MILL_SOCKET_*` env vars first, change the design only if tuning can't fix it.

---

### D-45 · The bot rebases onto origin/main before pushing

**Decision.** `ops/slack-bot/git.js`'s `commitAndPush` runs `git fetch` + `git rebase origin/main` before `git push`. A rebase conflict aborts (`git rebase --abort`) and leaves the commit local for the next batch to retry; it never force-pushes and never creates a merge commit. Every git failure (fetch, rebase, push) is posted to `#mill-ideas` via `notify.js`, not just logged.

**Why this needed recording.** The original `commitAndPush` did a bare `git push origin main`. During the projects phase both a founder (from a laptop / GitHub web) and the bot (capture batches every 15 min, per-idea commits from `/attack` `/test` `/proto` `/audit`) push to `origin/main`, so the remote moves out from under the bot constantly. A bare push then fails, and — because `docs/COMMANDS.md` correctly says never to block a command on git — the failure was swallowed to `console.error`, where nobody sees it. Captures and ideas were being committed locally and silently never reaching the shared repo that D-21/D-38 depend on.

**Why rebase, not merge.** Keeps `origin/main` linear and keeps each capture/idea commit as a single reviewable change. Conflicts are very unlikely in practice (capture files are per-founder and append-only, D-42; idea directories are per-id) — but if one happens, aborting and retrying is safe because the commits are append-only by construction, so a later batch just re-applies cleanly on top of whatever landed.

**Revisit when:** rebase conflicts start actually happening (they shouldn't), or a case appears where the bot needs to push something that genuinely conflicts with concurrent human edits — at which point the retry-forever loop needs a give-up-and-alert bound.

---

### D-46 · MiniMax M3 / the `mechanical` tier removed

**Decision.** The `mechanical` model tier (MiniMax M3) is removed from the system entirely: no `model_list` entry in `~/stack/litellm/config.yaml`, no `mill-mech` virtual key, no `MILL_MECH_KEY` in `~/.config/mill/env`, no `MiniMax` provider spend cap. Document indexing (Part 17 of the projects phase, `docs/PROJECTS.md`) — the only place `mechanical` was ever going to be used — uses `flash-fast` instead.

**Supersedes** D-12, which reserved MiniMax M3 for "bulk scrape, classify, summarise."

**Why.** MiniMax never had a key provisioned (`MINIMAX_API_KEY` was blank from Part 7 onward, so the route would 400 on first use) and was only ever *referenced* prospectively for indexing. Standing up a fourth provider — a fourth key to rotate, a fourth spend cap to watch, a fourth failure mode — to save a few cents per document index is not worth it when Fable is ~73% of real spend and `flash-fast` indexes a document perfectly well. The projects phase forced the question by making document indexing real; the answer was to drop the tier, not wire it up.

**Cost effect.** The runbook's $3/month "Mechanical" line folds into the buffer. No capability lost — `flash-fast` (Gemini 3.7 Flash, `thinking_level: low`) handles the ~150-word summary + key-figures extraction that indexing needs.

**Revisit when:** a genuine high-volume mechanical workload appears (bulk classification over thousands of items, where `flash-fast`'s per-call cost actually adds up) — at which point compare current cheap models fresh, don't assume MiniMax.

---

### D-47 · Per-project channels; `#research` retired

**Decision.** A promoted idea gets its own Slack channel, `#idea-<id>-<slug>`, with five stage anchor threads (Brainstorm, Research, Audit, Prototype, Documents) whose `thread_ts` are stored in `ideas/<id>/state.json`. Every command run in a project channel posts into its stage thread; context is keyed on `thread_ts`, never on channel, so the four conversations in one channel don't bleed into each other. `#research` is **retired** — research reports and audit verdicts now live in each project's Research and Audit threads. `#graveyard` (cross-project kill feed) and `#mill-ideas` (lobby: chat brainstorm, promotion announcements, `/themes`) stay.

**Supersedes** the flat `#mill-ideas` / `#research` layout in D-05's table and `runbook.md`. `docs/PROJECTS.md` is the spec for the channel/thread structure, the same way `docs/COMMANDS.md` (D-41) is the spec for command behaviour.

**Why.** Documents (D-... Part 17) need somewhere to live, and a flat `#research` with every idea's reports interleaved doesn't scale past a handful of live ideas. One channel per idea makes the graveyard browsable (archived channels, D-... Part 18.1) and gives each stage its own conversational context.

**Compatibility.** Pre-projects ideas that have no `channel_id` (e.g. `be67`) still fall back to the flat `#research` channel, which is why the env var and channel aren't deleted. New work never uses it.

**Requires** the `channels:manage` Slack scope (added in the projects phase).

**Revisit when:** never, without an explicit decision to flatten the structure again.

---

### D-48 · No static host; two sandbox network profiles

**Decision.** There is no static hosting provider (no Cloudflare Pages / Netlify, no `STATIC_HOST_TOKEN`). Every prototype — frontend or backend — is built unmounted and becomes reachable only by taking the single always-up ngrok slot on port 3200 via an explicit **Mount** (build-guide-projects Part 18). The Docker sandbox has **two distinct network profiles**, not one toggle:

- **build profile** — used while `/proto` generates and prepares an artifact, including any `npm install`. Egress allowlist: `registry.npmjs.org` only.
- **mount profile** — used when a prototype is mounted and publicly reachable through ngrok. Egress: **deny-all plus DNS**. No package installs happen at mount time, so nothing else is needed.

**Why no static host.** It's another account, another token to rotate, another free-tier limit to track, and another deploy path to debug from a phone — to save the ngrok slot for backend prototypes. Frontend prototypes are occasional under D-24/D-29; queuing them through the one ngrok slot is acceptable and keeps the surface small. Contention on the slot is handled by the take-over flow in Part 18.5, not by adding infrastructure.

**Why two profiles.** A mounted, LLM-written app that is publicly reachable (behind basic-auth, on a box holding the API keys) is exactly what D-06's egress allowlist guards. It has no legitimate reason to reach anything but DNS, so it gets deny-all-plus-DNS. The build step genuinely needs the npm registry and nothing else. Collapsing these into one "egress" network (the pre-D-48 state) meant the mount profile was as open as the build profile — `iptables DOCKER-USER` now enforces each separately. **C-17 must pass** once Part 18 is built; it can no longer stay failing (it was the binary none/egress toggle that made it fail).

**Amends D-06** (which said "network egress allowlisted" without distinguishing build from run) and the Part 10 `run.sh` design (single `egress` network).

**Revisit when:** frontend prototypes become frequent enough that the single ngrok slot is a real bottleneck — at which point reconsider a static host, comparing current free tiers fresh.
