# Experiment Spec: Touch 5 Outreach Cap Test

**Core Assumption:** A 5th low-friction touchpoint yields incremental qualified conversations (≥1.5% positive reply rate) without triggering negative signal thresholds (>0.4% unsubscribe/spam rate).

---

## 1. Test Setup

* **Sample Size:** 500 unengaged leads who received Touches 1–4 with no response.
* **Timing:** Day 14 (3 business days after Touch 4).
* **Split:**
  * **Control (Cap at 4):** 250 leads — No Touch 5 sent. Status set to `Nurture - 60 Day Cooldown`.
  * **Variant A (The 9-Word Micro-Question):** 125 leads.
  * **Variant B (Permission-Based Resource Drop):** 125 leads.

---

## 2. Touch 5 Copy Variants

### Variant A: Micro-Question (Subject: Re: [Previous Subject])
> Hi {{First_Name}},
> 
> Are you still focused on reducing {{specific_pain_point}} this quarter, or should I take you off my radar for now?
> 
> — {{My_Name}}

### Variant B: Permission Drop (Subject: Quick resource for {{Company_Name}}?)
> Hi {{First_Name}},
> 
> We put together a 1-page teardown on how {{Competitor/Peer_Type}} handles {{specific_pain_point}}. 
> 
> Worth sending a 2-minute Loom walkthrough, or are you fully set here?
> 
> — {{My_Name}}

---

## 3. Success & Kill Criteria

| Metric | Target (Proceed with Touch 5) | Kill Threshold (Cap Cadence at Touch 4) |
| :--- | :--- | :--- |
| **Incremental Reply Rate** | ≥ 1.5% total replies | < 0.8% total replies |
| **Positive Sentiment %** | ≥ 50% of replies | < 25% of replies |
| **Opt-Out / Unsub Rate** | ≤ 0.5% | ≥ 1.0% |
| **Spam / Domain Penalty** | 0 spam complaints | ≥ 1 spam flag |

---

## 4. Rapid Scorecard (Log after 7 days)

| Cohort | Sent | Total Replies | Positive Replies | Unsubs / Spam | Recommendation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Control (Stop at 4)** | 250 | — | — | 0 | *Baseline* |
| **Variant A (Micro-Q)** | 125 | `___` | `___` | `___` | `[ ] Adopt  [ ] Kill` |
| **Variant B (Resource)** | 125 | `___` | `___` | `___` | `[ ] Adopt  [ ] Kill` |