#!/usr/bin/env bash
set -uo pipefail

# Part 12 healthcheck. Runs from cron every 30 min (see crontab). Four
# checks, each of which posts to #mill-ideas at most once per condition
# per hour:
#
#   1. Per-key daily LiteLLM budget over THRESHOLD (D-23).
#   2. mill-chat.service not `active` (systemd).
#   3. mill-chat heartbeat file stale > HEARTBEAT_STALE_MIN minutes --
#      catches a wedged-but-not-exited bot before socket-health.js's own
#      triggers would (belt and braces).
#   4. Root filesystem over DISK_PCT_WARN %.
#
# EVERY run appends one line to stdout (cron redirects to
# ~/logs/healthcheck.log) whether or not anything alerted -- "silent
# success" is how the previous version hid the fact that nobody could
# tell if it was running at all. ops/conformance.py C-24 asserts this log
# has a fresh line.
#
# Needs LITELLM_MASTER_KEY (from ~/stack/litellm/.env) for /key/info and
# SLACK_BOT_TOKEN + SLACK_CHANNEL_MILL (from ~/.config/mill/env) to post.
# This is the only thing on the box that holds the master key; the bot's
# own env never does.

source /home/agent/.config/mill/env
source /home/agent/stack/litellm/.env

THRESHOLD="0.70"
DISK_PCT_WARN=85
HEARTBEAT_STALE_MIN=10
HEARTBEAT_FILE="${MILL_HEARTBEAT_FILE:-/home/agent/logs/mill-chat.heartbeat}"
LITELLM_BASE_URL="${LITELLM_BASE_URL:-http://127.0.0.1:4000}"
STATE_DIR="/home/agent/.cache/mill-healthcheck"
mkdir -p "$STATE_DIR"

NOW_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Alert de-dup bucket: one alert per condition per clock-hour, so a
# persistent problem re-pings hourly rather than every 30 min (annoying)
# or once and never again (missed).
HOUR_BUCKET=$(date -u +%Y-%m-%dT%H)

alerts_sent=0
summary=()

# alert <condition-key> <message>
alert() {
	local key="$1" msg="$2"
	local state_file="$STATE_DIR/${key}-${HOUR_BUCKET}.alerted"
	[ -f "$state_file" ] && return 0
	curl -s -X POST https://slack.com/api/chat.postMessage \
		-H "Authorization: Bearer $SLACK_BOT_TOKEN" \
		-H "Content-Type: application/json" \
		-d "{\"channel\":\"${SLACK_CHANNEL_MILL}\",\"text\":\"mill-01 healthcheck: ${msg}\"}" \
		>/dev/null && touch "$state_file"
	alerts_sent=$((alerts_sent + 1))
}

# --- 1. per-key daily budget ------------------------------------------
declare -A KEYS=(
	[mill-flash]="${MILL_FLASH_KEY:-}"
	[mill-research]="${MILL_RESEARCH_KEY:-}"
	[mill-audit]="${MILL_AUDIT_KEY:-}"
)
for alias in "${!KEYS[@]}"; do
	key="${KEYS[$alias]}"
	[ -z "$key" ] && { summary+=("$alias:nokey"); continue; }
	info=$(curl -s -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
		"${LITELLM_BASE_URL}/key/info?key=$key")
	spend=$(echo "$info" | jq -r '.info.spend // empty')
	budget=$(echo "$info" | jq -r '.info.max_budget // empty')
	if [ -z "$spend" ] || [ -z "$budget" ] || [ "$budget" = "0" ]; then
		summary+=("$alias:unreadable")
		alert "budget-read-$alias" "cannot read spend/budget for \`$alias\` from LiteLLM (/key/info returned nothing usable)"
		continue
	fi
	pct=$(awk -v s="$spend" -v b="$budget" 'BEGIN { printf "%.4f", s / b }')
	pct_display=$(awk -v p="$pct" 'BEGIN { printf "%.0f", p * 100 }')
	summary+=("$alias:${pct_display}%")
	over=$(awk -v p="$pct" -v t="$THRESHOLD" 'BEGIN { print (p >= t) ? 1 : 0 }')
	if [ "$over" = "1" ]; then
		alert "budget-$alias-$(date -u +%Y-%m-%d)" "\`$alias\` at ${pct_display}% of its \$${budget}/day budget (\$${spend} spent). Resets at UTC midnight (05:30 IST)."
	fi
done

# --- 2. mill-chat.service --------------------------------------------
svc_state=$(systemctl is-active mill-chat 2>/dev/null || true)
summary+=("service:${svc_state:-unknown}")
if [ "$svc_state" != "active" ]; then
	alert "service-down" "\`mill-chat.service\` is *${svc_state:-unknown}*, not active. The Slack bot is down — captures and commands are being dropped."
fi

# --- 3. mill-chat heartbeat -----------------------------------------
if [ -f "$HEARTBEAT_FILE" ]; then
	hb_epoch=$(stat -c %Y "$HEARTBEAT_FILE")
	age_min=$(( ( $(date +%s) - hb_epoch ) / 60 ))
	summary+=("heartbeat:${age_min}m")
	if [ "$age_min" -gt "$HEARTBEAT_STALE_MIN" ]; then
		alert "heartbeat-stale" "mill-chat heartbeat is ${age_min} min stale (> ${HEARTBEAT_STALE_MIN}). The bot process may be wedged even though systemd still shows it running."
	fi
else
	summary+=("heartbeat:missing")
	# Only meaningful if the service claims to be up.
	[ "$svc_state" = "active" ] && alert "heartbeat-missing" "mill-chat is \`active\` but has never written its heartbeat file ($HEARTBEAT_FILE) — socket-health.js may not be loading."
fi

# --- 4. root disk --------------------------------------------------
disk_pct=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')
disk_pct="${disk_pct:-0}"
summary+=("disk:${disk_pct}%")
if [ "$disk_pct" -ge "$DISK_PCT_WARN" ]; then
	alert "disk-$(date -u +%Y-%m-%d)" "root filesystem at ${disk_pct}% (warn at ${DISK_PCT_WARN}%). Weekly cron cleanup may not be keeping up — check Docker layers and node_modules."
fi

# --- always emit one status line ---------------------------------------
echo "[$NOW_UTC] healthcheck ran — alerts_sent=${alerts_sent} — ${summary[*]}"

# Alert state older than 2 days is stale; keep the dir from growing.
find "$STATE_DIR" -name "*.alerted" -mtime +2 -delete 2>/dev/null || true
