# EVAL — Conformance and Efficacy Protocol

**Run:** monthly. Weekly is noise at ~15 audits/month.
**Reads:** `DECISIONS.md`, `runbook.md`, `telemetry/`, the repo itself.
**Produces:** `evals/YYYY-MM.md`, committed.

---

## Two questions, deliberately separated

| | Question | Evidence | Who answers |
|---|---|---|---|
| **Conformance** | Is the system as designed? | Scripted checks against the repo and running services | A script |
| **Efficacy** | Is the design any good? | Operational telemetry over time | A model, reading only telemetry and DECISIONS |

Conflating these produces a report that sounds thorough and decides nothing. A system can be perfectly conformant to a bad design, or produce good outcomes while violating half its own rules.

**Conformance failures are bugs. Efficacy failures are decisions to revisit.** Never treat one as the other.

---

## The self-review problem

Claude Code builds this system. If Claude then evaluates it with the build session's context, that is self-review — the failure mode D-20 and D-27 exist to prevent, applied to the architecture itself.

Two mitigations, both required:

1. **Layer 1 doesn't care who built it.** Scripted checks pass or fail identically regardless of authorship. Push as much of the evaluation into this layer as possible.
2. **Layer 3 runs in a fresh session** with no build context, reading only `DECISIONS.md` and `telemetry/`. It must not read build logs, prior eval reports, or the conversation that produced the design. It is judging the system on its record, not on its rationale.

If Layer 3 finds itself reconstructing why a decision was made rather than reading the entry, it has too much context. Start over.

---

# Layer 1 — Conformance

Deterministic. Implement as `ops/conformance.py`. Every check is pass/fail with a reason. **Do not ask a model what a script can prove.**

### Model routing

| Check | Passes if |
|---|---|
| `C-01` | No Fable 5 call originates outside the audit path (D-10) |
| `C-02` | Fable month-to-date spend ≤ $35 (D-23 tripwire) |
| `C-03` | No calls to Opus 5, Kimi K3, or any DeepSeek model (D-07, D-09, D-11) |
| `C-04` | Every model call from application code (the Slack bot, `ops/`) routes through the LiteLLM proxy — no direct provider `base_url` in the bot's own config or source. **Scope excludes `~/stack/litellm/config.yaml` itself** — LiteLLM's own `model_list` entries legitimately carry provider `api_base` (e.g. `mechanical`'s MiniMax endpoint); that's LiteLLM routing to a provider, not application code bypassing it. Checking the wrong layer here false-positives on day one. |
| `C-05` | Per-key daily budgets configured and non-null in LiteLLM |

### Gate integrity

| Check | Passes if |
|---|---|
| `C-06` | No audit input contains brainstorm transcript content (D-28) |
| `C-07` | No verdict of `proceed` carries `evidence_basis: web-only` (D-33) |
| `C-08` | Every research pass has an associated falsifiable assumption (D-28) |
| `C-09` | Every research pass with thin field evidence produced three questions and a who-to-ask (D-33) |
| `C-10` | Every `kill` verdict wrote to the originating founder's `graveyard.md` |

### Loop discipline

| Check | Passes if |
|---|---|
| `C-11` | No `/proto` invocation succeeded without a named assumption (D-29) |
| `C-12` | No prototype exceeded five touch iterations (D-29) |
| `C-13` | No profile diff was applied without a recorded approval (D-30) |
| `C-14` | Every capture in `minds/<founder>/captures/` is present in the shared repo and correctly attributed to its founder (D-38). **Supersedes** the original wording (`No founder's raw captures readable outside their own DM channel (D-31)`) — D-31 was superseded by D-38 before this check was ever implemented, and the old wording would fail against the system's deliberate, agreed-on behavior: captures arrive privately by DM but are readable by all three founders once committed. Caught while implementing telemetry against this file, before C-14 had a script behind it — recorded so the wrong version doesn't get built by a session that only reads the check text. |

### Isolation

| Check | Passes if |
|---|---|
| `C-15` | Prototype container has no host mount beyond scratch (D-06) |
| `C-16` | No credential env vars reachable from inside the prototype container (D-06) |
| `C-17` | Container egress allowlist is present and non-empty |
| `C-18` | Pi is never invoked outside its container for working prototypes (D-06) |

`C-16` is the one to verify by hand at least once per quarter, not just by script. An agent-written script that can read the Fable key is how a $24 line becomes four figures.

### Provenance

| Check | Passes if |
|---|---|
| `C-19` | Every capture carries a founder attribution |
| `C-20` | No capture file has been modified after its commit (D-42: captures are append-only) |
| `C-21` | Every structural change in the last month has a corresponding DECISIONS entry |
| `C-22` | No DECISIONS entry was deleted — superseded entries still present |

**`C-21` is the one that decays first.** A system whose decision record stops tracking its own changes has lost the property that makes this whole arrangement work.

---

# Layer 2 — Telemetry

Log per event to `telemetry/YYYY-MM.jsonl`. Without this, Layer 3 has nothing to judge.

```json
{
  "ts": "2026-09-03T14:22:00+05:30",
  "founder": "amit",
  "stage": "audit",
  "idea_id": "a3f9",
  "model": "fable-5",
  "tokens_in": 78000,
  "tokens_out": 14000,
  "cache_hit_ratio": 0.0,
  "cost_usd": 1.48,
  "wall_clock_s": 41,
  "verdict": "kill",
  "evidence_basis": "web-only",
  "reason_code": "no-willingness-to-pay-signal"
}
```

Per idea, track the chain: `capture_ts → first_brainstorm → research → audit → verdict → prototype? → touches → outcome`.

**Required derived metrics**

| Metric | Target | Reads on |
|---|---|---|
| Kill rate at gate | > 30% | D-10, D-28 |
| Share of audits with `evidence_basis: field` | rising | D-33 |
| Captures per founder per week | > 5 | D-37 |
| `/blindspot` and `/cross` invocations | > 0 | D-27 |
| Median touches per prototype | < 3 | D-29 |
| Profile diffs approved vs proposed | > 50% | D-30 |
| Cost per idea killed | falling | D-24 |
| Median capture → verdict latency | < 10 days | throughput |
| Graveyard resurrections | tracked | D-10 |

---

# Layer 3 — Judgement

Fresh session. Reads `DECISIONS.md` and `telemetry/` only.

For each decision below, the falsifier states what evidence would show it wrong. **Report the falsifier as triggered or not, with the number.** Do not offer opinions on decisions whose falsifier has not fired.

| Decision | Falsified if |
|---|---|
| **D-10** Fable at the gate | Kill rate < 30% over two months — the gate is a $24/month tollbooth on a road you were driving anyway. Or: killed ideas keep getting resurrected, meaning the gate is wrong rather than strict. |
| **D-33** Evidence merge | Field-evidence share is flat near zero after three months. Everything caps at `narrow`, the loop never completes, and the rule is blocking rather than raising the bar. |
| **D-28** Research ungated | Research spend exceeds audit spend by more than 2× while kill rate stays high — you are researching things that were obviously dead. |
| **D-27** Cross-pollination | `/cross` and `/blindspot` invocation counts near zero. Founders aren't using the feature that justified building profiles at all. |
| **D-26/D-30** Profiles | Diff approval rate below 50%, or profiles unedited by hand for two months. Either the profiles are wrong or nobody trusts them. |
| **D-29** Touch cap | Median touches at or above 4. Either the cap is too low or prototypes are being asked to do product work. |
| **D-25** Budget | Consistent underspend below 70%. The ceiling isn't binding and capability is being left unused. Or overspend, meaning the estimates were wrong. |
| **D-37** Build-first | Captures per founder below 5/week after two months. The most-used component isn't being used, which means the manual-first recommendation was right and the build was premature. |
| **D-08** Flash | Research reports repeatedly flagged thin on evidence quality by the auditor — the cheap tier may be the binding constraint on kill accuracy. |
| **D-01** Host | Memory pressure alerts more than twice a month, or disk-full incidents. |

**Output format**

```
## Conformance
PASS n/22 · failures listed with check ID and reason

## Telemetry
Table of the nine derived metrics, current vs target vs last month

## Falsifiers triggered
Per decision: triggered / not triggered, with the number

## Recommendation
At most three. Each names a decision ID and the evidence.
No recommendation without a triggered falsifier or a conformance failure.
```

That last constraint is the important one. An evaluation that generates suggestions on every run trains the founders to ignore it.

---

## What this cannot tell you

**Whether the audit gate is any good.** The only real test is whether ideas it killed would have worked, and whether ideas it passed later failed. That signal lags by months and may never arrive cleanly — you don't get to run the counterfactual. Track graveyard resurrections as the weak proxy and treat it as weak.

**Whether the ideas are any good.** The mill measures its own throughput. Three founders can process one bad idea per week per person very efficiently for a year.

**Whether the founders are talking to enough people.** D-33 enforces that field evidence exists before `proceed`, but the mill cannot make anyone pick up the phone. If field-evidence share stays near zero, the honest read is not that the tooling failed — it is that the mill became a substitute for the conversations rather than a preparation for them. That is the failure mode most worth watching, and it is the one the system is structurally least able to detect.
