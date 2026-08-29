# Build Guide v3 — The Mill

**Companion to:** `runbook.md`, `DECISIONS.md`
**Target:** Hetzner CX23 running LiteLLM (budget enforcement + model gateway), a custom Slack bot, isolated prototype sandbox
**Time:** ~30 min manual bootstrap, then a half-day driving Claude Code

> **Untested.** Written without network access — nothing here has been executed. The shell, systemd and Docker parts are conventional and low-risk.

> **Part 6 (Pi) is historical.** This guide originally installed Pi as an orchestrator layer. It was later uninstalled entirely (D-43) once every job it was chosen for turned out to already be owned by LiteLLM, the Slack bot, and Part 10's sandbox. A from-scratch build following this guide today should skip Part 6 — it's kept below only as the record of what was tried and why it turned out unnecessary, per the same never-delete convention `DECISIONS.md` uses.

**Split of work (D-22):**

| Parts | Who |
|---|---|
| 0–2 | **You, by hand.** Bootstrap up to the point Claude Code can exist |
| 3 | Handoff |
| 4–12 | Claude Code, driven from your phone |
| 13 | You, verifying |

---

# Part 0 — Accounts

Do this from your phone. Nothing needs a terminal.

### 0.1 Hetzner

Sign up at `hetzner.com/cloud`. **Start this today** — new accounts sometimes need ID verification before provisioning, which can add a day.

Create a project called `mill`.

### 0.2 Model providers

| Provider | For | Notes |
|---|---|---|
| Google AI Studio | Gemini 3.7 Flash | `aistudio.google.com`. Intro pricing ends 31 Dec 2026 |
| Anthropic Console | Fable 5 | Separate **workspace** for Fable so its spend is isolated (D-23) |

Set console spend caps now: Google $60, Anthropic-Fable workspace $35.

(MiniMax M3 / the `mechanical` tier was removed — D-46. No account needed.)

### 0.3 Search provider

Brave, Serper, Exa or Tavily. Free tier is fine to start. SearXNG self-hosting is deferred — build the paid path first.

### 0.4 Slack

1. `api.slack.com/apps` → **Create New App** → From scratch → name it `Mill`, pick your workspace
2. Note the **App ID**. Tokens come in Part 9.
3. Create channels: `#mill-ideas`, `#research`, `#graveyard`

### 0.5 GitHub

Private repo. You'll add a deploy key in Part 8.

**Upload your docs now** — `CLAUDE.md` at root, and `docs/runbook.md`, `docs/DECISIONS.md`, `docs/EVAL.md`. Use GitHub's mobile web upload. Claude Code must read the decision record *before* it starts building, or it builds against its own defaults.

---

# Part 1 — Provision (manual)

### 1.1 SSH key on your phone

Termux:
```bash
pkg update && pkg install openssh
ssh-keygen -t ed25519 -C "phone-primary"
cat ~/.ssh/id_ed25519.pub
```

Termius: **Keychain → New Key**. Either way, copy the public key.

### 1.2 Add it to Hetzner

Project → **Security → SSH Keys → Add**.

### 1.3 Create the server

| Field | Value |
|---|---|
| Location | **Falkenstein (FSN1)** |
| Image | **Ubuntu 24.04** |
| Type | Shared vCPU → x86 → **CX23** (2 vCPU, 4GB, 40GB) |
| Public IPv4 | **Yes** (+€0.50) |
| Public IPv6 | Yes |
| SSH key | The one above |
| Volumes | None |
| Firewall | Create: inbound **TCP 22** only |
| Backups | **Enable** (+20%) |
| Name | `mill-01` |

~€7/month all in.

### 1.4 Connect

```bash
ssh root@YOUR_IP
```

---

# Part 2 — Base hardening (manual — do not delegate)

### 2.1 User

```bash
apt update && apt upgrade -y

adduser --disabled-password --gecos "" agent
usermod -aG sudo agent

mkdir -p /home/agent/.ssh
cp /root/.ssh/authorized_keys /home/agent/.ssh/
chown -R agent:agent /home/agent/.ssh
chmod 700 /home/agent/.ssh
chmod 600 /home/agent/.ssh/authorized_keys

echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent
chmod 440 /etc/sudoers.d/agent
```

### 2.2 SSH lockdown — BY HAND, ALWAYS (D-22)

```bash
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

**Open a second session and confirm `ssh agent@IP` works before closing this one.**

Never let an agent touch this file. A malformed edit plus a restart locks you out of a box only reachable by SSH.

### 2.3 Swap and basics

```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

apt install -y fail2ban unattended-upgrades git tmux
systemctl enable --now fail2ban
```

### 2.4 Node 24

```bash
su - agent
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # v24.x

mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

---

# Part 3 — Hand off to Claude Code

```bash
npm install -g @anthropic-ai/claude-code
mkdir -p ~/workspace && cd ~/workspace
git clone git@github.com:sam14032000/mill-01.git   # or https + PAT for now
cd mill-01

tmux new -s cc
claude
```

Inside Claude Code:

```
claude remote-control --name "mill-01"
```

**tmux is not optional** — the session dies with your SSH connection otherwise, and your phone backgrounds the app constantly.

Now open the Claude app on your phone and connect. First instruction:

> Read CLAUDE.md and docs/DECISIONS.md before doing anything. Then work through docs/build-guide.md Parts 4 onward, stopping at the end of each part for confirmation.

---

# Part 4 — Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
tailscale ip -4
```

Install Tailscale on your phone, same account.

Once you've confirmed `ssh agent@100.x.x.x` works over the tailnet, **go back to the Hetzner Cloud Firewall and delete the inbound port 22 rule.** SSH then exists only on the tailnet.

Never enable `tailscale funnel` (D-04).

---

# Part 5 — Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker agent
newgrp docker
docker run --rm hello-world
```

Constrain the daemon so a runaway container can't eat the box:

```bash
sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "default-ulimits": { "nofile": { "Name": "nofile", "Soft": 4096, "Hard": 8192 } }
}
EOF
sudo systemctl restart docker
```

---

# Part 6 — Pi · REMOVED, historical only (D-43)

**Skip this on a fresh build.** Originally:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

Pi was installed as an orchestrator, with the intent that stage scripts and the Slack bot would shell out to it. Neither ever did — every command handler and `ops/research.py` call LiteLLM's `/chat/completions` directly (`ops/slack-bot/llm.js`, `audit-llm.js`), and Part 10's sandbox executes generated code directly without going through Pi either. Once `ops/conformance.py`'s C-18 check confirmed zero `pi -p`/RPC invocations anywhere in the codebase, Pi was uninstalled (`npm uninstall -g @earendil-works/pi-coding-agent`) — see D-03 (superseded) and D-43 for the full reasoning.

---

# Part 7 — LiteLLM (budget enforcement)

This is the piece that makes overnight spend impossible rather than merely capped monthly.

### 7.1 Stack

```bash
mkdir -p ~/stack/litellm && cd ~/stack/litellm
```

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: always
    environment:
      POSTGRES_DB: litellm
      POSTGRES_USER: litellm
      POSTGRES_PASSWORD: ${PG_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U litellm"]
      interval: 10s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: always
    command: redis-server --maxmemory 128mb --maxmemory-policy allkeys-lru

  litellm:
    image: ghcr.io/berriai/litellm:main-stable
    restart: always
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "127.0.0.1:4000:4000"
    volumes:
      - ./config.yaml:/app/config.yaml
    environment:
      DATABASE_URL: postgresql://litellm:${PG_PASSWORD}@postgres:5432/litellm
      REDIS_HOST: redis
      REDIS_PORT: "6379"
      LITELLM_MASTER_KEY: ${LITELLM_MASTER_KEY}
      LITELLM_SALT_KEY: ${LITELLM_SALT_KEY}
      GEMINI_API_KEY: ${GEMINI_API_KEY}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    command: ["--config", "/app/config.yaml", "--port", "4000"]

volumes:
  pgdata:
```

`config.yaml`:

```yaml
model_list:
  # Interactive commands (D-08 amendment). Gemini 3.x bills internal
  # reasoning as output tokens and defaults to thinking_level "high"
  # when unspecified -- that default is what made every call take
  # 90-180s+ while building /attack (ops/BUILD-LOG.md has the full
  # trail). thinking_level (not thinking_budget, not reasoning_effort)
  # is the Gemini 3.x control. Never leave it unspecified.
  - model_name: flash-fast
    litellm_params:
      model: gemini/gemini-3.7-flash
      api_key: os.environ/GEMINI_API_KEY
      max_tokens: 8192
      thinking_level: low
      drop_params: false

  # Research (Part 11) keeps more reasoning budget -- untested at any
  # level as of this build, deliberately left alone.
  - model_name: flash
    litellm_params:
      model: gemini/gemini-3.7-flash
      api_key: os.environ/GEMINI_API_KEY
      max_tokens: 8192
      thinking_level: medium
      drop_params: false

  - model_name: audit
    litellm_params:
      model: anthropic/claude-fable-5
      api_key: os.environ/ANTHROPIC_API_KEY
      max_tokens: 16384

  # NOTE: the `mechanical` (MiniMax M3) entry was removed in the projects
  # phase — D-46 / build-guide-projects.md Part 14.1. A from-scratch build
  # can skip it entirely: no MiniMax account, no MINIMAX_API_KEY, no
  # mill-mech key. Document indexing uses flash-fast. The block is left
  # here struck-through only so the D-number is discoverable from the guide.
  #
  # - model_name: mechanical
  #   litellm_params:
  #     model: openai/MiniMax-M3
  #     api_base: https://api.minimax.io/v1
  #     api_key: os.environ/MINIMAX_API_KEY

litellm_settings:
  # Global default stays true; flash/flash-fast override it per-model
  # above -- drop_params:true was very likely silently discarding
  # thinking_level before this was scoped per-entry.
  drop_params: true
  set_verbose: false
  cache: true
  cache_params:
    type: redis
    host: redis
    port: 6379

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL
  store_model_in_db: true
```

### 7.2 Secrets — you populate these, not the agent

```bash
cd ~/stack/litellm
cat > .env <<'EOF'
PG_PASSWORD=
LITELLM_MASTER_KEY=sk-
LITELLM_SALT_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
# MINIMAX_API_KEY removed — D-46 (mechanical tier dropped)
EOF
chmod 600 .env
```

Fill this in over SSH yourself. **There is no reason a build agent needs your Fable key in its context.**

```bash
docker compose up -d
curl -s http://127.0.0.1:4000/health/readiness
```

### 7.3 Virtual keys with daily budgets

This is the whole point — provider caps are monthly and trip after an overnight runaway. These reset daily. **The budgets below must actually be daily (`budget_duration: "1d"`) to do that job** — a `30d` duration was shipped here in an earlier build pass despite this section's own prose, found by conformance check C-05 in `docs/EVAL.md` and fixed.

**Interactive and research traffic have different cost profiles and must not share a key or budget.** A single research pass costs roughly as much as 250 interactive exchanges — one `/test` on a shared budget can starve every founder's brainstorming for the rest of the day. `mill-flash` (scoped to `flash-fast` only) and `mill-research` (scoped to `flash` only) are separate keys for this reason, not a naming convenience.

```bash
MASTER=$(grep LITELLM_MASTER_KEY .env | cut -d= -f2)

# interactive: /attack, /think, /cross, /blindspot, /themes, /proto
curl -s -X POST http://127.0.0.1:4000/key/generate \
  -H "Authorization: Bearer $MASTER" -H "Content-Type: application/json" \
  -d '{"key_alias":"mill-flash","models":["flash-fast"],
       "max_budget":1.00,"budget_duration":"1d",
       "rpm_limit":60}'

# research: /test only
curl -s -X POST http://127.0.0.1:4000/key/generate \
  -H "Authorization: Bearer $MASTER" -H "Content-Type: application/json" \
  -d '{"key_alias":"mill-research","models":["flash"],
       "max_budget":3.00,"budget_duration":"1d",
       "rpm_limit":60}'

# the audit gate — tight, deliberately
curl -s -X POST http://127.0.0.1:4000/key/generate \
  -H "Authorization: Bearer $MASTER" -H "Content-Type: application/json" \
  -d '{"key_alias":"mill-audit","models":["audit"],
       "max_budget":2.00,"budget_duration":"1d",
       "rpm_limit":5}'

# mill-mech (MiniMax) removed — D-46 / build-guide-projects.md Part 14.1.
# Skip on a from-scratch build; there are three virtual keys, not four.
```

The daily amounts on `mill-audit` and `mill-mech` are D-23's monthly caps divided across ~30 days with headroom, not a fresh estimate: $35/30 ≈ $1.17, $10/30 ≈ $0.33, rounded up to $2.00 / $0.50 respectively so a normal day's usage doesn't nuisance-trip the cap while an overnight runaway still gets stopped same-day rather than 30 days later. `mill-flash`/`mill-research` are sized directly from measured per-command cost (`ops/BUILD-LOG.md`), not from D-23's undifferentiated $60 Gemini line — `mill-flash` is **$1.00/day** and `mill-research` **$3.00/day** (roughly two research passes at ~$1.50 each). `mill-flash` was $0.50/day through the D-51 build; D-53 put a `flash-fast` agent-loop call on *every* conversational turn (not just slash commands), observed peak reached $0.50/day and tripped the cap, so it was raised to $1.00 via `/key/update` (D-23).

**Application code routes to the correct key automatically, keyed off model name** (`ops/slack-bot/llm.js`), so a caller can't accidentally put a `/test` call on the interactive budget or vice versa by getting the key wrong.

**Per-call cost comes from LiteLLM's `x-litellm-response-cost` header, with one exception: cache hits.** On a cache hit LiteLLM returns that header with the *would-be uncached* price but bills nothing. `llm.js`/`audit-llm.js` detect the hit (`x-litellm-cache-key` response header is present only on a hit) and record `cost_usd: 0` / `cache_hit_ratio > 0`. Since the brainstorm prefix is cached deliberately (`cache: true` in `config.yaml`), most brainstorm calls hit — trusting the raw header would inflate `cost_usd` on the majority of events. `ops/conformance.py` C-23 guards both directions.

**LiteLLM's daily budget window resets at UTC midnight — 05:30 IST, not a rolling 24 hours from key creation.** Confirmed directly via `/key/info`'s `budget_reset_at` field. An evening exhaustion (e.g. 8pm IST) blocks that key until 5:30am IST the next day, not a few hours later — worth knowing before treating a "budget exceeded" error at night as a quick wait.

Save the returned keys to `~/.config/mill/env`. **Everything downstream points at `http://127.0.0.1:4000` and uses these, never a provider key directly** (conformance check C-04).

Spend at any time:

```bash
curl -s -H "Authorization: Bearer $MASTER" \
  http://127.0.0.1:4000/global/spend/report | jq
```

---

# Part 8 — Repo

```bash
cd ~/workspace/mill-01

mkdir -p minds/{saksham,amisha,vaibhav}/captures
mkdir -p minds/shared ideas evals telemetry ops runners
touch minds/shared/{themes.md,dynamics.md}

for f in minds/*/; do touch "$f/profile.md" "$f/graveyard.md"; done
```

Deploy key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub   # add to GitHub → Settings → Deploy keys, write access

cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
EOF
```

`.gitignore`:

```
.env
*.key
node_modules/
__pycache__/
```

---

# Part 9 — Slack transport

**Scope: wiring only.** Connection lifecycle, D-40 allowlist, channel routing,
systemd service. No command logic — see Part 9b. `pi-chat` does not support
Slack (D-03/D-39 corrections); this is a custom bot on the Slack Bolt SDK
that talks to LiteLLM directly, with no Pi in between (D-43).

**Stop and verify before Part 9b.** A DM from an allowlisted founder must
create a correctly attributed capture file. A DM from anyone else must
produce no reply and no file. Do not start command implementation until
both are confirmed.

### 9.1 App config

At `api.slack.com/apps` → your app:

**Socket Mode** → enable. This avoids inbound webhooks entirely, which matters because your firewall has no open ports.

**OAuth & Permissions** → Bot Token Scopes:
`app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `commands`, `files:read`, `im:history`, `im:read`, `im:write`, `users:read`

**Event Subscriptions** → enable → subscribe to `message.im`, `message.channels`, `app_mention`

**Slash Commands** — create each with a placeholder request URL (Socket Mode ignores it):
`/think`, `/cross`, `/blindspot`, `/attack`, `/test`, `/audit`, `/proto`, `/themes`

**Install to Workspace.** Collect:
- Bot User OAuth Token (`xoxb-…`)
- App-Level Token with `connections:write` (`xapp-…`)

### 9.2 Wire the Bolt bot

```bash
cd ~/workspace/mill-01/ops/slack-bot && npm install
```

Add to `~/.config/mill/env`:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
LITELLM_BASE_URL=http://127.0.0.1:4000
MILL_FLASH_KEY=sk-...
MILL_RESEARCH_KEY=sk-...
MILL_AUDIT_KEY=sk-...
FOUNDER_SAKSHAM=U01ABC
FOUNDER_AMISHA=U02DEF
FOUNDER_VAIBHAV=U03GHI
SLACK_CHANNEL_MILL=C...
SLACK_CHANNEL_RESEARCH=C...
SLACK_CHANNEL_GRAVEYARD=C...
```

```bash
chmod 600 ~/.config/mill/env
```

Map Slack user IDs to `minds/<name>/` directories. **Attribution drives profile routing and is not optional** (D-40). Identity comes only from Slack's verified `user_id` against this static map — no passphrase, no secondary login. Anything off the map is dropped silently.

**`SLACK_CHANNEL_*` must be channel IDs (`C…`/`G…`), not `#names`.** `chat.postMessage` still resolves a `#name`, but `conversations.*` calls don't, and name resolution breaks silently on a channel rename. `config.js` logs a warning at startup for any value that isn't ID-shaped. To get an ID from a name without the `channels:read` scope: `chat.postMessage` to the `#name` and read `.channel` off the response (delete the message after). Blank `FOUNDER_*` entries are fine — that founder just isn't onboarded yet.

### 9.3 Service

```bash
sudo tee /etc/systemd/system/mill-chat.service > /dev/null <<'EOF'
[Unit]
Description=Mill Slack bot
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=agent
EnvironmentFile=/home/agent/.config/mill/env
WorkingDirectory=/home/agent/workspace/mill-01/ops/slack-bot
Environment=PATH=/home/agent/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node /home/agent/workspace/mill-01/ops/slack-bot/index.js
Restart=always
RestartSec=10
StandardOutput=append:/home/agent/logs/chat.log
StandardError=append:/home/agent/logs/chat.log

[Install]
WantedBy=multi-user.target
EOF

mkdir -p ~/logs
sudo systemctl daemon-reload
sudo systemctl enable --now mill-chat
```

**Wedge recovery (`socket-health.js`).** A half-open Socket Mode connection
leaves the process `active` while silently dropping inbound events —
`Restart=always` never fires because nothing exits. `socket-health.js`
(started from `index.js` after `app.start()`) turns three conditions into a
non-zero `process.exit`, so `RestartSec=10` rebuilds the connection:
websocket pong stale > 90s; more than 3 consecutive pings with no pong; or
no inbound Slack event for 15 min *and* a live `auth.test` probe also fails.
It also maintains `~/logs/mill-chat.heartbeat` (rewritten on every inbound
event and every 60s), which Part 12's healthcheck alerts on when stale.
Thresholds are env-overridable (`MILL_SOCKET_PONG_STALE_MS`,
`MILL_SOCKET_SILENCE_MS`, `MILL_SOCKET_MAX_PING_MISSES`,
`MILL_HEARTBEAT_FILE`). `index.js` also logs one `[inbound]` line per
dispatched Slack request (shape only, no message content) — permanent,
since its absence is what made the 2026-08-27 wedge undiagnosable.

Log rotation:

```bash
sudo tee /etc/logrotate.d/mill > /dev/null <<'EOF'
/home/agent/logs/*.log {
  weekly
  rotate 8
  compress
  missingok
  copytruncate
}
EOF
```

---

# Part 9b — Command implementations

**Do not start until Part 9 is confirmed working.** Implements `docs/COMMANDS.md`
against the transport built in Part 9.

**Build order:** `/attack` first — it is the only command that creates an
idea, and every other command operates on one that already exists. Then the
brainstorm-shaped commands, lower stakes individually: `/think`, `/cross`,
`/blindspot`, `/themes`. Then `/test`, which drives the Part 11 research
pass. **`/audit` last** — its JSON validation and the D-33 web-only-caps-at-
`narrow` enforcement (C-07 in `docs/COMMANDS.md`) is the most load-bearing
code in the system, and every command before it exists to feed that gate
correctly.

**Git commit/push (`ops/slack-bot/git.js`).** `commitAndPush` is shared by
capture batching (every 15 min, `git-batch.js`) and per-idea commits
(`/attack`, `/test`, `/proto`, `/audit`). It `fetch`es and `rebase`s onto
`origin/main` before pushing — both a founder and the bot push during normal
use, so the remote moves out from under it routinely; without the rebase the
push just fails and the commit silently never leaves the box. A rebase
conflict (rare — capture files are per-founder append-mostly) aborts cleanly,
leaving the commit local for the next batch to retry. Any failure is posted
to `#mill-ideas` via `notify.js` (a raw `chat.postMessage`, no Bolt handle
needed), per `docs/COMMANDS.md`'s failure table, not just `console.error`d.

---

# Part 10 — Prototype sandbox (D-06)

**The one component whose job is to contain a misbehaving agent. Verify it yourself.**

`~/stack/sandbox/Dockerfile`:

```dockerfile
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 python3-pip ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 10001 proto
USER proto
WORKDIR /scratch
```

`curl` is required here, not optional -- the verify-by-hand tests below
use it. Found by running them: without curl, both network tests report
"clean"/"BLOCKED-UNEXPECTEDLY" regardless of actual network state,
because `curl: command not found` exits non-zero and falls through to
the `||` branch either way. That's a false pass, not a real one — the
tests were re-run with `python3 -c "import socket; ..."` to get a
genuine signal before curl was added back.

`~/stack/sandbox/run.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
# A caller that already needs a specific pre-populated directory (e.g.
# /proto writing an artifact before executing it) can pass one via
# MILL_SANDBOX_SCRATCH_DIR instead of getting a fresh empty one -- same
# permission handling applies either way, so this stays the one place
# that does it rather than callers duplicating the security config.
SCRATCH="${MILL_SANDBOX_SCRATCH_DIR:-$(mktemp -d /home/agent/scratch/proto-XXXXXX)}"
mkdir -p "$SCRATCH"
# mktemp defaults to 700, owned by whichever host user ran this script.
# The container always runs as a fixed uid (10001, "proto") that won't
# match the host user's uid, so without this the container can create
# nothing in its own scratch mount -- found by testing the mount
# end-to-end, not assumed from :rw on the bind mount. World-writable is
# acceptable here: fresh, per-invocation, ephemeral (D-29 deletes
# prototypes by default), not a shared or long-lived location.
chmod 777 "$SCRATCH"

# D-06: network egress allowlisted, not open by default. Default is
# `none` -- full isolation, no egress at all. A prototype that names a
# specific external dependency (e.g. testing whether an API returns
# usable data) opts in explicitly per run:
#   MILL_SANDBOX_NETWORK=egress ~/stack/sandbox/run.sh '...'
# `egress` is a named Docker network created once during setup below --
# this is the boundary between "no network" and "network," made an
# explicit per-run choice rather than a default. It is not yet a
# per-host allowlist (nothing here restricts *what* the egress network
# can reach) -- that's a real gap, left for whoever builds Part 10 to
# close before a prototype with the egress network actually runs
# unattended, not something to treat as already solved by this default.
NETWORK="${MILL_SANDBOX_NETWORK:-none}"

docker run --rm -i \
  --name "proto-$(basename "$SCRATCH")" \
  --user 10001:10001 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  -v "$SCRATCH":/scratch:rw \
  --memory 1g --memory-swap 1g --cpus 1 --pids-limit 256 \
  --cap-drop ALL --security-opt no-new-privileges \
  --network "$NETWORK" \
  --env-file /dev/null \
  mill-sandbox:latest \
  bash -lc "$*"

echo "artifacts: $SCRATCH"
```

```bash
mkdir -p ~/scratch
chmod +x ~/stack/sandbox/run.sh
docker build -t mill-sandbox:latest ~/stack/sandbox
docker network create egress   # opt-in network for Part 10's run.sh; not restricted to any allowlist yet
```

**Verify by hand — do not accept the agent's word:**

```bash
~/stack/sandbox/run.sh 'env | grep -i -E "key|token|secret" && echo LEAK || echo clean'
~/stack/sandbox/run.sh 'ls /home/agent 2>&1 | head'
~/stack/sandbox/run.sh 'cat /home/agent/.config/mill/env 2>&1 | head'
~/stack/sandbox/run.sh 'curl -s --max-time 3 https://example.com >/dev/null && echo LEAKED-NETWORK || echo clean'
MILL_SANDBOX_NETWORK=egress ~/stack/sandbox/run.sh 'curl -s --max-time 3 https://example.com >/dev/null && echo reaches-network || echo BLOCKED-UNEXPECTEDLY'
```

Expect `clean` and permission errors on the first three, `clean` (not `LEAKED-NETWORK`) on the fourth with the default network, and `reaches-network` on the fifth with `MILL_SANDBOX_NETWORK=egress` opted in. Anything else, stop and fix before a prototype ever runs.

---

# Part 11 — GPT Researcher

**Built and verified with a real pass.** Hybrid mode is D-33's actual mechanism (web sources plus the founders' field notes as local documents), not something to route around — confirmed working, not just configured. Full implementation is `ops/research.py` in the repo; not reproduced here in full to avoid exactly the kind of drift this build kept finding in itself (CLAUDE.md's Conventions). What follows is the reasoning behind the non-obvious parts.

```bash
sudo apt install -y python3-venv
python3 -m venv ~/venv && source ~/venv/bin/activate
pip install gpt-researcher
```

**Known packaging bug in `gpt-researcher==0.16.0` (the current PyPI release as of this build): `gpt_researcher/actions/query_processing.py` uses `Any`/`List`/`Dict` in a function signature before importing them** -- a `NameError` on first import, not something specific to this deployment. Already fixed on the project's `master` branch (imports moved above the function that needs them) but not yet released to PyPI. Rather than install from git master and risk pulling in other unreleased instability, the same one-line reordering was applied directly to the installed copy:

```bash
# In ~/venv/lib/python3.12/site-packages/gpt_researcher/actions/query_processing.py,
# move the five `from ... import` / `import logging` lines that sit after
# _normalize_sub_queries()'s definition to before it. Re-check when upgrading
# gpt-researcher -- once a release includes the upstream fix, this step is
# no longer needed.
```

`~/workspace/mill-01/ops/research.py` -- key points, not the full listing:

- **No OpenAI account, ever.** `OPENAI_API_BASE`/`OPENAI_API_KEY` are the fixed variable names the OpenAI-compatible client GPT Researcher uses internally expects -- that's the standard, LiteLLM-recommended way to point *any* OpenAI-compatible client at a non-OpenAI server. They can't be renamed without breaking the integration; nothing here ever talks to OpenAI. Pointed at `LITELLM_BASE_URL` and `MILL_RESEARCH_KEY` -- not `MILL_FLASH_KEY`, which is scoped to `flash-fast` only and would 403 against the `flash` model this script needs (Part 7.3: research and interactive traffic have separate keys and budgets because a research pass costs roughly as much as 250 interactive exchanges).
- **`FAST_LLM`/`SMART_LLM`/`STRATEGIC_LLM` set explicitly to `openai:flash`.** GPT Researcher's own defaults are real OpenAI model names (`openai:gpt-4o-mini` etc.) with no equivalent in `config.yaml` -- redirecting the API base alone doesn't fix this; every call would 400 against a model the proxy doesn't have.
- **`EMBEDDING=openai:embed`.** Same problem as above, for GPT Researcher's local-document ranking (what makes hybrid mode work at all). Fixed by adding an `embed` model to `config.yaml` (`gemini/gemini-embedding-001` -- current model name verified against Google's own docs, not `text-embedding-004`, the older Vertex-path model), scoped to `mill-research`, confirmed directly against the proxy's `/embeddings` endpoint before wiring it in.
- **`RETRIEVER=tavily`, explicit rather than left to GPT Researcher's default.** Part 0.3 listed Brave/Serper/Exa/Tavily without settling one; the founder settled it as Tavily, and `TAVILY_API_KEY` is in `~/.config/mill/env`. Both currently resolve to the same provider, but setting it explicitly means a future upstream default change can't silently switch providers underneath this build. Plan/quota on file recorded in `ops/BUILD-LOG.md`.
- **`report_type="research_report"`, never `"deep"`.** Benchmark evidence shows increased search depth consistently degrades factual accuracy while citation metrics stay flat -- an information-overload effect. Shallow passes are the accuracy-preserving choice, not just the cheap one.
- **Citation re-check (D-20).** Re-fetches a sample of sources (default 3) and asks the `flash` model, per source, to decompose into sub-questions rather than judge holistically, ending in SUPPORTED/UNSUPPORTED/UNCLEAR. Real limitation, stated in the code rather than hidden: GPT Researcher's report is prose, not a structured citation map, so this checks "does this source's content corroborate the report's overall thrust," not "does it support this specific sentence." Discrepancies (including fetch failures -- some sources 403 real re-fetch attempts) are appended under `## Citation issues`.
- **Gap output (D-33).** Only when `evidence_basis` is `web-only`: one `flash` call asking for three resolving questions and who to ask. Never asserts anything, so it doesn't carry D-20's risk the way a claim would.
- **`research_stub: false`** in the output JSON, always -- this is the real pipeline, not `ops/slack-bot`'s Phase 2 stub. `/audit`'s `research_stub` gate (built before this existed) will now actually let a real report through.

---

# Part 12 — Cron and healthcheck

`~/workspace/mill-01/ops/healthcheck.sh` runs from cron every 30 min and does four checks, each alerting `#mill-ideas` (channel id from `SLACK_CHANNEL_MILL`) at most once per condition per clock-hour:

1. **Per-key daily budget** over 70% (D-23) — `spend`/`max_budget` via `/key/info` (`/global/spend/report` is LiteLLM Enterprise-only and 402s here). Reset window is UTC midnight (Part 7.3).
2. **`mill-chat.service` not `active`** — `systemctl is-active`.
3. **`~/logs/mill-chat.heartbeat` stale > 10 min** — `socket-health.js` rewrites it every inbound event and every 60s, so staleness means the bot is wedged even if systemd still shows it running (belt-and-braces against `socket-health.js`'s own exit triggers missing).
4. **Root filesystem** over 85%.

**Every run appends one `[<utc>] healthcheck ran — …` line to `~/logs/healthcheck.log`, pass or fail.** Silent success is how the earlier version hid whether it was running at all; `ops/conformance.py` C-24 now asserts that line is fresh. Alert de-dup state lives in `~/.cache/mill-healthcheck/<key>-<hourbucket>.alerted`, pruned after 2 days. It runs standalone (not in the bot) because it's the only thing on the box that holds `LITELLM_MASTER_KEY` (sourced from `~/stack/litellm/.env`) — the bot's env never does. Full implementation is in the script, not reproduced here, per the drift convention.

```cron
*/30 * * * * /home/agent/workspace/mill-01/ops/healthcheck.sh >> /home/agent/logs/healthcheck.log 2>&1
0 3 * * 0    docker system prune -af --volumes >> /home/agent/logs/cleanup.log 2>&1
5 3 * * 0    find /home/agent/scratch -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} + >> /home/agent/logs/cleanup.log 2>&1
```

Both cleanup lines are installed and running as of this build. `docker system prune` runs unprivileged — `agent` is in the `docker` group (confirmed via `getent group docker` and a live `docker system df`; a stale shell session can look otherwise since group membership is only picked up on new login, which is exactly the state a cron-spawned process always starts from), matching `~/stack/sandbox/run.sh`'s own unprivileged `docker run` (Part 10) — no sudoers entry needed or added. The scratch prune targets top-level entries only (`-mindepth 1 -maxdepth 1`), matching the `proto-<id>` directory names `/proto` actually creates there, not the `-type d` glob originally sketched (which would silently skip stray files).

**Weekly profile evolution is not a cron job.** It originally was sketched as `ops/profile_diff.py` on a `30 9 * * 0` line, but D-30's approve/reject flow needs Socket Mode's persistent Slack connection, which only the always-on `mill-chat` process holds — a one-shot cron script would need its own bot connection just to post two buttons and wait. Built instead as `ops/slack-bot/weekly-scheduler.js`, an in-process interval inside `mill-chat` that checks a UTC day/hour window (Sunday 04:00 UTC = 09:30 IST, no DST) every 5 minutes and fires `ops/slack-bot/profile-evolution.js`'s `runWeeklyProfileEvolution()` once per week (tracked via an ISO-week marker file, so a restart mid-window can't double-fire). That function generates a `flash-fast` diff per active founder's `profile.md` plus one shared `dynamics.md` diff, and posts each to Slack with Approve/Reject buttons (DM for a profile diff, `#mill-ideas` for the shared one, per D-27's framing of `dynamics.md` as everyone's file). Approving is the only code path that writes the proposed content — `ops/slack-bot/index.js`'s `profile_diff_approve` action handler, which only runs on an explicit human click; rejecting just deletes the pending diff and logs the outcome. Directly tested (not just started and assumed working): a real `flash-fast` call against sparse data correctly resolves to "no diff proposed" rather than crashing (Gemini 3.x can reason over a near-empty prompt and legitimately emit no visible text — `finish_reason: "stop"`, not the previously-seen `"length"` reasoning-budget-exhaustion case — caught in `profile-evolution.js`'s `callFlashForDiff`, not in `llm.js`, since every other command correctly still needs an empty reply to be a hard, surfaced error); a second run against a real capture produced a correctly-shaped unified diff for `profile.md`.

`ops/eval.py` (the monthly EVAL.md Layer 3 review) still doesn't exist and has no cron line — out of scope for this build; D-EVAL's Layer 3 explicitly wants a fresh session with no build context, which a cron-invoked script wired into this repo's history would defeat.

---

# Part 12b — Conformance script (EVAL.md Layer 1)

`ops/conformance.py` implements the `docs/EVAL.md` Layer 1 checks, C-01 through C-24 (C-23 telemetry-cost accuracy and C-24 healthcheck-log freshness were added after the original C-01..C-22 table). No cron line — run by hand (`python3 ops/conformance.py`) whenever a conformance read is wanted; EVAL.md's own cadence is monthly, alongside Layer 3. Not `ops/eval.py`, the name EVAL.md's Layer 3 cron sketch used — that name is reserved for the fresh-session judgement pass, which doesn't exist yet and shouldn't be confused with this deterministic one.

Every check is a grep, a file read, a git command, or an HTTP call to LiteLLM's own `/key/info` and `/spend/logs` endpoints (master-key-authenticated, same pattern `healthcheck.sh` already uses) — never a model call, per EVAL.md's "do not ask a model what a script can prove." Needs the `docker` group active in its shell (same as the weekly cleanup cron and `run.sh` itself) for C-17's `docker network inspect`/`iptables` check; a freshly-spawned process (cron, new SSH session) has this, an already-open shell from before the group was granted may not.

**Real findings from the first run, not hypothetical:**

- **C-17 genuinely fails.** The `egress` Docker network `run.sh` uses for network-enabled prototypes is a plain bridge with no `DOCKER-USER` iptables rule restricting what it can reach — confirmed directly (`docker network inspect egress`, `iptables -L DOCKER-USER -n`), matching what `run.sh`'s own comment already says (Part 10): the none/egress choice is a binary toggle, not a per-host allowlist. A real, already-acknowledged gap — close it before any working prototype actually needs `MILL_SANDBOX_NETWORK=egress` unattended.
- **This system never invoked Pi — founders' call: remove it rather than wire it in.** Checked directly (`grep` across `ops/` for any `pi -p`/`spawn("pi")`/RPC usage — none). Raised as a finding rather than resolved unilaterally, per CLAUDE.md's rule on structural decisions; the founders' answer was to uninstall Pi and record the harness choice as moot (D-03 marked superseded, D-43 added) rather than retrofit the bot to route through it. `npm uninstall -g @earendil-works/pi-coding-agent` run; Part 6 above marked historical.
- **`eval-event.js`'s `buildEvalEvent` mis-prices every non-Gemini telemetry event.** It always calls `geminiFlashCost()` regardless of the `model` field passed in, so every `stage: "audit"` telemetry line (Fable 5, ~$1.60/call per D-10) is logged with Gemini's $0.75/$3.75-per-M rates instead of Fable's actual cost — silently wrong, not just imprecise (checked directly: LiteLLM's own `/spend/logs` shows real per-call Fable spend around $0.035-$0.04 for a trivial test prompt, using LiteLLM's correct built-in Anthropic pricing, which the `x-litellm-response-cost` response header also exposes per-call and could replace the hardcoded Gemini-only calculator entirely). Not fixed here, since it touches every command's telemetry call site — flagged because EVAL.md Layer 2's derived metrics (cost per idea killed, D-24's core metric) depend on `cost_usd` being right, and this bug means audit-stage cost has been wrong since Part 9b. C-02 sidesteps it by reading LiteLLM's `/spend/logs` directly rather than trusting telemetry's `cost_usd` for Fable spend, which is why C-02 passes correctly despite this bug.

---

# Part 13 — Commissioning (you, by hand)

- [ ] `ssh agent@100.x.x.x` works over Tailscale
- [ ] Hetzner Cloud Firewall port 22 rule **removed**
- [ ] `tailscale funnel status` shows nothing enabled
- [ ] `curl 127.0.0.1:4000/health/readiness` returns healthy
- [ ] All three virtual keys (`mill-flash`, `mill-research`, `mill-audit`) created with daily budgets; `/key/info?key=<key>` returns `spend`/`max_budget` for each — `/global/spend/report` is Enterprise-only and will 402, don't use it (`mill-mech` removed, D-46)
- [ ] Nothing outside `~/stack/litellm/.env` contains a provider API key — `grep -rIl "sk-ant\|AIza" ~/workspace` returns nothing
- [ ] Sandbox leak tests from Part 10 all return `clean` / permission denied, and the default-network vs `MILL_SANDBOX_NETWORK=egress` pair behaves as documented (blocked by default, reaches out when opted in)
- [ ] Slack: a DM to the bot creates a capture file attributed to the right founder
- [ ] `/think` returns in `#mill-ideas`
- [ ] `/proto` **refuses** without a named assumption
- [ ] Research pass produces a report with `evidence_basis` set correctly
- [ ] Audit with web-only evidence **cannot** return `proceed`
- [ ] `docker compose down && up -d` — LiteLLM keys and spend survive
- [ ] **Reboot the server.** Confirm chat bot and LiteLLM come back unaided

That last one matters more than it looks. A stack that doesn't survive a reboot isn't a background system — it's a session you happen to have left open.

---

## After commissioning

Run the loop for a month, then execute `docs/EVAL.md`. Layer 3 of that protocol must run in a **fresh session with no build context** — otherwise the thing that built the system is grading its own work.
