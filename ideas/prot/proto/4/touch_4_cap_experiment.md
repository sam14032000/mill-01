# Experiment: Touch 4 Cap & Variation Test

**Core Assumption:** A 4th touchpoint still generates net-positive pipeline without triggering prospect fatigue (defined as unsubscribe/negative reply rates exceeding positive replies).

---

## 1. Test Setup (Send on Day 9 — 3 days after Touch 3)

Assign 150 prospects (50 per arm) who have opened at least one previous email but have not replied.

### Arm 1: Control (Standard Follow-up / Value Bump)
> **Subject:** Re: [Original Subject]  
>  
> Hi {{First_Name}},  
>  
> Following up on my note from Tuesday regarding {{pain_point}}. We recently helped {{similar_company}} reduce {{metric}} by {{X%}}.  
>  
> Open to a 10-minute chat this Thursday?

---

### Arm 2: Variation A (The "Permission-to-Close" Micro-Touch)
> **Subject:** Re: [Original Subject]  
>  
> Hi {{First_Name}} — should I assume this isn’t a priority for {{Company}} this quarter and take you off my follow-up list?  
>  
> Let me know either way.

---

### Arm 3: Variation B (The Frictionless Yes/No Routing)
> **Subject:** Re: [Original Subject]  
>  
> Hi {{First_Name}} — quick sanity check: are you the right person handling {{specific_initiative}}, or should I reach out to someone else on your team?

---

## 2. Decision Gate & Kill Criteria

Run across $N = 150$ total sends over 5 business days.

| Metric | Target (Keep Touch 4) | Red Flag (Hit Touch Cap / Kill Touch 4) |
| :--- | :--- | :--- |
| **Positive Reply Rate** | $\ge 4.0\%$ (2+ meetings booked) | $< 1.5\%$ (0–1 replies) |
| **Opt-Out / "Remove Me" Rate** | $\le 2.0\%$ ($\le 3$ unsubscribes) | $\ge 4.0\%$ (6+ unsubscribes) |
| **Spam / Hostile Sentiment** | $0$ reports | $\ge 1$ spam report or hostile reply |

---

## 3. Results Log

| Arm | Sends | Opens | Pos. Replies | Neg. / Unsubs | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Arm 1 (Control)** | 50 | | | | [ ] Winner [ ] Cap Exceeded |
| **Arm 2 (Var A: Micro)** | 50 | | | | [ ] Winner [ ] Cap Exceeded |
| **Arm 3 (Var B: Routing)** | 50 | | | | [ ] Winner [ ] Cap Exceeded |

**Action Post-Test:**  
- If any variation achieves $>4\%$ positive replies with $<2\%$ unsubscribes $\rightarrow$ incorporate as permanent Touch 4.  
- If all arms trigger $>3\%$ unsubscribes or $<1.5\%$ positive replies $\rightarrow$ **Touch cap is 3 touches.** Hard stop sequence at Touch 3.