# Build Guide — Projects Phase (Parts 14–19)

**Continues from:** `build-guide.md` Parts 0–13
**Spec:** `docs/PROJECTS.md`
**Target:** chat tier, promotion, project channels, documents, mountable prototypes

> **Untested.** Written without network access. Shell, systemd and Docker parts are conventional. Anything ngrok- or Slack-API-specific must be verified against current docs — those are the commands most likely to have moved.

**Split of work:**

| Part | Who |
|---|---|
| 14.0 | **You, by hand.** Accounts, scopes, secrets. |
| 14–18 | Claude Code, one part at a time |
| 19 | You, verifying |

**Verification rule for this phase.** Build continuously — do not stop for manual Slack testing between parts. But after each part, run automated verification and report raw output before continuing. If a check fails, stop.

Five silent failures occurred in Parts 0–13, every one of which looked fine from the outside. **Prefer checks that assert a positive signal over checks that confirm no error.**

---

# Part 14.0 — Prerequisites (manual)

## 14.0.1 Slack scope

`api.slack.com/apps` → Mill → **OAuth & Permissions** → Bot Token Scopes → add:

```
channels:manage
```

Then **Reinstall to Workspace**. Check whether `xoxb-` changed; if so, update `~/.config/mill/env`.

## 14.0.2 Channels

In Slack, create `#chats`. Invite the bot: `/invite @Mill`.

Leave `#research` in place for now — Part 16 retires it.

## 14.0.3 ngrok

You have the endpoint. Collect:

- **Authtoken** — dashboard → Your Authtoken
- **Static domain** — dashboard → Domains

Confirm your plan allows a persistent agent session. Free tier has historically permitted only one simultaneous session, which is enough for the single-endpoint design but not more.

## 14.0.5 Secrets

```bash
nano ~/.config/mill/env
```

Append:

```
NGROK_AUTHTOKEN=
NGROK_DOMAIN=
PROTO_BASIC_AUTH_USER=mill
PROTO_BASIC_AUTH_PASS=
SLACK_CHANNEL_CHATS=<channel id, C…>
```

Generate the basic-auth password with `openssl rand -hex 12`. Save it to your password manager — you'll share it alongside prototype URLs.

```bash
chmod 600 ~/.config/mill/env
```

## 14.0.6 Hand over

```bash
tmux attach -t cc
```

> Read docs/PROJECTS.md and add it to CLAUDE.md imports. Then work through docs/build-guide-projects.md starting at Part 14. Stop at the end of each part, run its verification block, and report raw output before continuing. Do not proceed past a failed check.
>
> Prerequisites done: channels:manage added and app reinstalled, #chats created, ngrok secrets in ~/.config/mill/env. No static host — all prototypes go through the ngrok slot (D-48).

---

# Part 14 — Chat tier (P1)

## 14.1 Drop MiniMax first

Never had a key; only referenced for document indexing. Not worth a fourth provider and a fourth key to rotate when Fable is ~73% of real spend.

- Remove the `mechanical` entry from `~/stack/litellm/config.yaml`
- Delete the `mill-mech` virtual key via `/key/delete`
- Remove `MILL_MECH_KEY` from `~/.config/mill/env`
- Use `flash-fast` wherever `mechanical` was referenced
- DECISIONS entry recording this

## 14.2 `/chat`

`/chat <topic>` posts a thread root in `#chats` and replies in-thread.

**Session state keyed on `thread_ts`, never on channel.** `#chats` will hold many parallel sessions; channel-level binding causes silent context bleed.

## 14.3 Message routing

| Where | Plain message is |
|---|---|
| `#chats` thread | Conversational turn, with running context |
| DM to bot | Capture (unchanged) |
| Project channel thread | Conversational turn in that stage |

Do not collapse these paths.

## 14.4 Commands in chat

`/think`, `/cross`, `/blindspot`, `/themes`, `/find`.

**`/attack` writes nothing here.** Returns the case against plus the `ASSUMPTION:` line, then presents the promote button pre-filled with that assumption. No idea, no `state.json`, no directory.

## 14.5 `/find`  (`/search` is reserved by Slack)

1–3 Tavily queries, summarised in-thread. No report file, no citation re-check, no `evidence_basis`.

**It is never evidence.** Visually distinct from a research report, with a footer saying so. On promotion it transcribes as conversation, never as research.

This is load-bearing: `/find` masquerading as research routes straight around the audit's web-only cap, and that's how a `proceed` gets built on three headlines.

## 14.6 Compaction

At 30 turns, using `flash-fast`:

- Summarise turns 1–20 into a compact block, keep the last 10 verbatim; repeat every 30 turns
- The summary **must preserve any assumption, number, or named alternative** raised — those are what `/attack` and promotion depend on
- Post a visible marker in-thread
- **Compaction never affects what promotion stores.** `origin-chat.md` gets the full transcript

## 14.7 Nightly capture

Append each founder's own messages from unpromoted chats to their captures file. Cron, alongside the existing jobs.

## Verify Part 14

```
- 5-turn chat retains context
- a second concurrent chat does not bleed into the first
- compaction fires at turn 30 and preserves a number stated at turn 3
- /find output carries its not-evidence footer
- /attack creates nothing on disk (confirm with git status and ls ideas/)
- a DM still produces a capture, not a conversational reply
```

---

# Part 15 — Promotion (P2)

## 15.1 The button

Block Kit action on every bot reply in a chat thread:

> **[ Start a project from this idea ]**

Always present, no threshold.

## 15.2 Triggered prompts

Never silently refuse. Always offer the button.

| Founder does | Bot |
|---|---|
| Uploads a file | "I can't store files in a chat — start a project and I'll keep it with the idea." |
| Runs `/test`, `/proto`, `/audit` | "That needs a project." |
| Asks to build, save, or keep something | Same |

## 15.3 On promotion

1. Generate idea id, create `ideas/<id>/`
2. Write the **full** transcript to `ideas/<id>/origin-chat.md`
3. Create the project channel (Part 16 — until then, flat structure)
4. Seed Brainstorm with a summary of the origin chat and a link back
5. Post links in the chat thread and `#mill-ideas`
6. Set the assumption if one came from `/attack`; otherwise note `/test` needs one

Promoting late must lose nothing. That's what makes the gate free.

## Verify Part 15

```
- promotion from a 40-turn chat captures all 40 turns in origin-chat.md, not the compacted view
- a pre-filled assumption carries into state.json
- failed channel creation creates no idea at all (simulate the failure)
- an upload attempt in a chat offers the button rather than failing silently
```

---

# Part 16 — Project channels (P3)

## 16.1 Channel creation

`#idea-<id>-<slug>`, lowercase, ≤80 chars total. All three founders auto-invited. Topic is the assumption.

## 16.2 Anchor threads

Five messages posted at creation. Store `thread_ts` for each in `state.json`:

```
🧠 Brainstorm   → /think /cross /blindspot /attack, conversation
🔍 Research     → /test, field evidence, reports
⚖️ Audit        → verdicts
🔨 Prototype    → /proto, mount/dismount, touches
📎 Documents    → uploads
```

## 16.3 Routing

Every command posts to its stage thread. **Context keyed on `thread_ts`** — one channel, four parallel conversations, and channel-level binding leaks research findings into brainstorm silently.

## 16.4 Retire `#research`

Reports move to each project's Research thread. Update `runbook.md`, `COMMANDS.md`, and the conformance script.

## Verify Part 16

```
- each command posts to the correct stage thread
- research context does not appear in a brainstorm reply in the same channel
- a missing thread_ts reposts anchors rather than posting to channel root
- all three founders are members on creation
```

---

# Part 17 — Documents (P4)

Project channels only.

## 17.1 Capture

On `file_shared`: download via `files.info` → `url_private` with the bot token, write to `ideas/<id>/docs/`, collision-suffix `-2`/`-3` never overwrite, commit attributed to the uploader, react ✅.

**Download at upload time, never lazily.** Slack is not storage — files there are subject to plan retention.

## 17.2 Size limits

| Size | Behaviour |
|---|---|
| < 5 MB | Accept |
| 5–20 MB | Accept, warn about repo bloat |
| > 20 MB | Refuse, ask for an extract |

Git keeps every version of every binary forever, on a 40 GB disk.

## 17.3 Indexing

`flash-fast` generates an entry appended to `docs/index.md`: filename, uploader, date, size, pages, type, ~150-word summary, 3–5 key figures.

PDF and images go to Gemini natively. `.docx`/`.xlsx` need conversion. Text and markdown pass through.

## 17.4 Context rules — cost-critical

- **Default: index only.** A 47-page report is ~30k tokens; across 20 turns that's 600k tokens for content already read
- `/think @filename <question>` — that document's full text, that call only
- `/think @all <question>` — everything, ~$0.15 at 200k tokens
- `/test` passes `docs/` as GPT Researcher's `DOC_PATH` — D-33's hybrid mechanism
- **Audit gets the index, not the documents** (D-28)
- `index.md` is stable within a session — cached prefix, beside the profile, before captures

## Verify Part 17

```
- brainstorm reply after upload includes index content, not document body
- @filename includes the body
- a 25MB file is refused
- extraction failure still stores the raw file with index marked "extraction failed"
- a download failure posts the filename rather than dropping silently
```

---

# Part 18 — Lifecycle and prototypes (P5)

## 18.1 Archive on kill

A `kill` verdict archives the channel after posting the verdict. History retained. Killing gets a visible action; the graveyard becomes browsable.

## 18.2 Spin-off

`/spinoff <idea>` from inside a project creates a child, records `parent` and `children` both ways, links the child's first message back, and notes it in the parent's Brainstorm thread.

No spin-off from a chat — just start another chat.

## 18.3 ngrok service — **as built**

One static tunnel on port 3200, always up, its own systemd service. **Do not create tunnels dynamically.**

- **Template, not literal config.** `~/stack/ngrok/ngrok.yml.tmpl` holds the structure with `${...}` placeholders. `~/stack/ngrok/render.sh` sources `~/.config/mill/env` and `envsubst`s it into `~/.config/ngrok/ngrok.yml` (chmod 600). ngrok v3 does **not** reliably interpolate `${VAR}` in its own config, and the authtoken/password must not sit in a template — so the real file is generated at service start.
- **`mill-ngrok.service`** (`User=agent`): `ExecStartPre=render.sh`, `ExecStart=ngrok start --config ~/.config/ngrok/ngrok.yml proto`, `Restart=always`, logs to `~/logs/ngrok.log`.
- **traffic-policy syntax was verified** against current ngrok docs (2026-08): `type: basic-auth` under `on_http_request[].actions[].config.credentials: ["user:pass"]`, specified **inline** under `endpoints[].traffic_policy` — `ngrok config check` accepts it. No CLI-flag fallback needed.
- The rendered file:

```yaml
version: "3"
agent:
  authtoken: <from env>
endpoints:
  - name: proto
    url: <NGROK_DOMAIN, a full https:// URL>
    upstream:
      url: 3200
    traffic_policy:
      on_http_request:
        - actions:
            - type: basic-auth
              config:
                realm: "mill prototype"
                credentials:
                  - "<user>:<pass>"
```

When nothing is mounted, `mill-proto-idle` (a 64 MB container) serves a plain "no prototype mounted" page on 3200. **A shared URL must never 502** — `mount.sh down`/`idle` always restore it.

⚠️ **The `NGROK_AUTHTOKEN` handed over (`ep_…`, ~30 chars) is not a valid ngrok agent authtoken** — that's an API-key/endpoint-token format. A real agent authtoken is ~49 chars, no prefix, from dashboard.ngrok.com/get-started/your-authtoken. The service is built and disabled until the correct token lands in `~/.config/mill/env`.

## 18.4 Build vs mount

Separate acts.

`/proto <id> <assumption>` **builds only.** Every prototype — frontend or backend — is built and left unmounted; there is no static host (D-48). A prototype becomes reachable only by taking the single ngrok slot via **Mount**.

## 18.5 Mount / dismount

Buttons in the Prototype thread.

- `[ Mount ]` — starts the container behind 3200, posts URL and basic-auth credentials
- `[ Dismount ]` — stops it, frees the slot
- **Default 30 minutes.** `/proto mount <id> 2h` overrides. **Cap 8 hours** — nothing LLM-written stays publicly reachable overnight unattended
- **Warn at 5 minutes remaining** with an `[ Extend ]` button. Silent expiry mid-demo is the annoying failure
- **Contention:** if another founder's prototype is mounted, do not queue and do not auto-evict. Report which idea, which founder, time remaining, plus `[ Take over ]`. Taking over posts a note in the displaced idea's thread

## 18.6 State

In `state.json`: `mounted_at`, `mounted_by`, `expires_at`, `touch`.

**On bot restart, reconcile against actual running containers** rather than trusting stored state.

## 18.7 Verification before reporting live

Check the Agent API before posting any URL:

```bash
curl -s http://localhost:4040/api/tunnels | jq '.tunnels[] | {public_url, addr: .config.addr}'
```

**Never report a prototype live on assumption.**

## 18.8 Guardrails — **as built**

An LLM wrote this code and your API keys are on the same box.

- **Two network profiles (D-48), one enforcement point.** `~/stack/sandbox/net-setup.sh` creates `mill-build` (172.30.0.0/24) and `mill-mount` (172.31.0.0/24) and rebuilds the `DOCKER-USER` iptables chain: ESTABLISHED/RELATED RETURN, DNS (udp+tcp 53) RETURN for both, tcp/443 to `104.16.0.0/13` (npm's Cloudflare range) RETURN for **build only**, then a catch-all `-j DROP` for each subnet. `mill-sandbox-net.service` (oneshot, `After=docker.service`) applies it at boot; a `docker.service` drop-in re-applies it after any daemon restart (which flushes `DOCKER-USER`). The old unrestricted `egress` network is deleted.
- **Verified positively, not "no error":** from inside a `mill-mount` container, `socket.create_connection(("1.1.1.1",443))` → *timeout*, `example.com:443` → *Network unreachable*, `93.184.216.34:80` → *timeout*; `socket.gethostbyname("example.com")` → *resolves*, `1.1.1.1:53` → *connects*. From `mill-build`: `registry.npmjs.org:443` → *connects*, `1.1.1.1:443` → *fails*, `example.com:80` → *fails*.
- 512 MB / 0.5 CPU, `--pids-limit 128`, uid 10001, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` + `--tmpfs /tmp`, scratch-only `:ro` mount, `--env-file /dev/null` (+ only `-e PORT=8080`, not a credential).
- **C-17 rewritten and passing** — it now asserts `DOCKER-USER` has a catch-all DROP for each sandbox subnet and no non-DNS accept for `mill-mount`. C-15/C-16 extended to cover `mount.sh` as well as `run.sh`.
- `~/stack/sandbox/refresh-npm-allowlist.sh` is the tripwire for npm moving off Cloudflare (re-resolves `registry.npmjs.org`, warns if any IP falls outside the allowed range).

## 18.9 DECISIONS

- **D-04 revised.** Tunnels are outbound-only and open no inbound ports, but this is public exposure of LLM-written code on the host holding our keys. Record the reasoning and guardrails, not just the change
- **D-06 revised** for long-running containers — the original assumed ephemeral `--rm`
- **D-29 unaffected** — five-touch cap and delete-by-default stand

## Verify Part 18

```
- a backend prototype mounts, is reachable, and prompts for basic auth
- the unmounted tunnel serves the placeholder, not a 502
- auto-dismount fires at 30 min; explicit 2h honoured; 12h rejected
- 5-minute warning posts with a working Extend button
- a second founder mounting sees contention info and a Take over button
- bot restart while mounted reconciles correctly
- C-17 passes
- sandbox leak tests still return clean
```

---

# Part 19 — Commissioning (yours)

Run these by hand. The container's job is to contain a misbehaving agent — don't accept its own assurance that it works.

```bash
# credentials unreachable from a prototype container
~/stack/sandbox/run.sh 'env | grep -iE "key|token|secret" && echo LEAK || echo clean'
~/stack/sandbox/run.sh 'cat /home/agent/.config/mill/env 2>&1 | head -3'

# egress allowlist actually enforced
~/stack/sandbox/run.sh 'python3 -c "import socket;socket.create_connection((\"1.1.1.1\",53),3)" 2>&1 | tail -1'

# nothing secret in the repo
grep -rnE "sk-ant|AIza|tvly-|xoxb-|ngrok" ~/workspace/mill-01 2>/dev/null

# memory headroom with a prototype mounted
free -h

# survives a reboot
sudo reboot
```

After reboot: bot answers a DM, LiteLLM healthy, ngrok tunnel up, cron intact.

## End-to-end, by hand

1. `/chat` — a real idea, 5+ conversational turns
2. `/find` — confirm the not-evidence footer
3. `/attack` — assumption with a number and a named alternative
4. **Promote** — check `origin-chat.md` has every turn
5. Upload a document — check it commits and indexes
6. `/test` — answer the field prompt with something real, check the report cites it
7. `/audit` — read the verdict
8. `/proto` and mount — open the URL from a phone on mobile data, not wifi
9. If `kill` — confirm the channel archives

Then check the repo:

```bash
cd ~/workspace/mill-01 && git log --oneline -10
tail -20 telemetry/$(date +%Y-%m).jsonl
node ops/conformance.js
```

Telemetry is the one to read carefully. It has been the quietest failure in this build, and a review with no data is the expensive way to find out.

---

## After commissioning

Run it for a month. Then execute `docs/EVAL.md` in a **fresh session with no build context**.

Kill rate and field-evidence share are the two numbers that say whether any of this was worth building.
