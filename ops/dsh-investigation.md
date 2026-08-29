# dsh (DeepSeek Harness) — investigation

**Status:** investigation, not a build. The adoption decision is the founders' and reopens D-43.
**Scope:** two questions only — (1) does it embed as a library alongside the Bolt bot on the 2 GB box, (2) can our existing Docker sandbox plug in as the sandbox plugin without re-validating D-06/D-48 from scratch.
**Method:** npm registry metadata for `@deepseek-ai/*` (a full install + on-box spike was not done — see "What still needs the hands-on spike").

---

## What dsh actually is (confirmed)

- **Real, and DeepSeek's own.** `@deepseek-ai/dsh@0.1.1-rc.2`, MIT, repo `github.com/deepseek-ai/deepseek-harness`, published ~1 week ago, maintained by `tianyicui-deepseek@deepseek.com` and `imccyu`. 10 published versions total.
- **Cordis plugin architecture, confirmed.** Depends on `@deepseek-ai/cordis@^4.0.1` (a Cordis fork). ~40 `@deepseek-ai/dsh-*` sub-packages, each a plugin/seam: `dsh-base` (the base plugin rows over an empty profile), `dsh-goal` (event-sourced session goal state), `dsh-skill` (skill-provider registry), `dsh-schedule` (durable after/at/rate reminders over the session event log), `dsh-tool-bash` / `dsh-tool-web` / `dsh-tool-fs` (model-facing tools), `dsh-fs-local` ("local-filesystem implementation of the harness filesystem **seam** (`ctx.fs`)"), `dsh-persona`, `dsh-plan-mode`, `dsh-terminal`, `dsh-web-app`, `dsh-headless`, etc. So model / tools / filesystem / schedule / persona / persistence are all Cordis `ctx.*` seams with swappable implementations — the user's description holds.
- **It ships an embed bundle.** `@deepseek-ai/dsh-headless` — "the dsh one-shot bundle: a direct core Agent/Session runner over dsh-base **with no Host, HTTP, or browser layer**." This is the form you would `require()` inside the Bolt process. It is a designed entry point, not a hack.
- **Pre-1.0.** `0.1.1-rc.2`. This is exactly the concern D-03 raised when it first rejected dsh ("a developer preview warning in capital letters about breaking changes between release candidates"). The 135k-star figure is the GitHub repo; the shipped npm packages are release-candidate, days old at this version.

---

## Question 1 — embeds as a library alongside Bolt on 2 GB?

**Architecturally: yes.** `dsh-headless` exists precisely for "run the core Agent/Session, no Host/HTTP/browser." That is the integration shape — Bolt stays the process, dsh-headless is a library it calls.

**Operationally: unproven, and two real risks:**

1. **Footprint.** `@deepseek-ai/dsh` pulls 62 direct deps and ~40 `dsh-*` sub-packages. `dsh-headless` trims the Host/HTTP/browser layers but still pulls `dsh-base` + goal + skill + schedule + tool-\* + persona + cmdline + their transitive deps. `node_modules` size and — the number that matters — **resident memory of an embedded event-sourced Cordis runtime next to Bolt + the LiteLLM client on a 2 GB box with 4 GB swap** is unmeasured. The current bot idles around ~60 MB.
2. **Native addons.** The dep tree includes `node-addon-require-builtin` and `node-addon`-style packages. Building native addons on a 2 GB DigitalOcean droplet with no dev machine is fragile — `npm install` itself can OOM or need `--build-from-source` handling, and there is no local machine to prebuild on.

**Verdict:** the embed path is designed and real; whether it *fits this box* is the open question, and it needs an actual install + `ps -o rss` measurement on the droplet.

---

## Question 2 — does our Docker sandbox plug in without re-validating D-06/D-48?

**There is a seam.** `dsh-tool-bash` is described as a "model-facing bash tool with optional generic background-task and **sandbox-escalation support**", and `ctx.fs` is an explicit filesystem seam (`dsh-fs-local` is one impl). So dsh is built to have its execution/isolation layer swapped.

**But the shape of that seam is undetermined from metadata, and it decides everything:**

- **Good case:** the seam is "dsh hands you a command string, you return `{stdout, stderr, ok}`." Then our `~/stack/sandbox/run.sh` invocation slots straight in, and D-06 (`--env-file /dev/null`, `--cap-drop ALL`, `--user 10001`, scratch-only mount) and D-48 (two networks, `iptables DOCKER-USER` deny-all-plus-DNS, the positive egress tests) are **preserved unchanged** — we are still the ones calling `docker run` with our profile.
- **Bad case:** "sandbox-escalation" means dsh owns the container lifecycle and you *configure* its sandbox (image, mounts, network) through the seam. Then every D-06/D-48 property has to be re-expressed in dsh's configuration model and **re-verified from scratch** — the iptables rules, the two network profiles, the credential-unreachability test, the positive "a socket connect to an off-allowlist host fails" check. That is not a plug-in; that is a security re-audit.

Which one it is requires reading `@deepseek-ai/dsh-tool-bash`'s `.d.ts` and the sandbox-seam interface. Not answerable from package descriptions.

---

## What still needs the hands-on spike (the actual 1 day)

1. `npm install @deepseek-ai/dsh-headless` on the droplet — does it install at all on 2 GB, native addons and all.
2. Minimal embedded agent (one LiteLLM model seam, one no-op tool), measure RSS delta vs the current bot.
3. Read `dsh-tool-bash` + the sandbox/`ctx.fs` seam types — is `run.sh` a drop-in function, or does dsh own the container.
4. Read `dsh-goal` / the session event-log format — is session state exportable to our flat JSON schema, or only replayable within dsh (the hard requirement: exportable = reversible).
5. Confirm the LiteLLM path: a model seam pointing at `LITELLM_BASE_URL` with our virtual keys, tool-calling through it.

---

## Recommendation (for the founders' decision)

**Do not adopt dsh now.** Pre-1.0 (`0.1.1-rc.2` — the exact D-03 concern), unmeasured footprint on a weak box, native-addon install risk with no dev machine, and the load-bearing sandbox-seam question unresolved. Adopting release-candidate infrastructure as the orchestration layer of a hardened live system is the wrong risk right now.

**It is a strong "revisit at 1.0" candidate.** The architecture is right for this use — Cordis seams for model (→ LiteLLM), tools (→ the 9 commands), sandbox (→ `run.sh`, *if* the seam is a function), schedule, persistence — and DeepSeek is actively building it. Do the 5-step spike above before the next architecture cycle so that when dsh stabilises the decision is evidence-based.

**In the meantime,** the hand-rolled Phase 1 + Phase 2 agent loop (D-53) sits behind `agent.runTurn()` and reads/writes session state in the project's own flat JSON schema. That boundary is the bridge: swapping the loop for dsh-headless later touches `agent.js` and a session-export adapter, not the tools and not the session format.
