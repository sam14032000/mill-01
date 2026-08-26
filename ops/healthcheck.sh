#!/usr/bin/env bash
set -uo pipefail

# Budget-warning half of Part 12's healthcheck (docs/build-guide.md).
# Disk/memory/service-status checks are not implemented yet -- deferred
# to whoever builds the rest of Part 12. This covers only the daily
# per-key budget threshold alert, which needed real per-key /key/info
# data against 1d budgets (D-23 amendment) to be worth building.
#
# Runs as a standalone cron job, not inside the always-on Slack bot
# process -- this is the only thing on the box that needs
# LITELLM_MASTER_KEY. The bot's own env (~/.config/mill/env) never
# holds it, deliberately, to keep the bot's credential scope to just
# the four virtual keys it actually needs.

source /home/agent/.config/mill/env
source /home/agent/stack/litellm/.env

THRESHOLD="0.70"
STATE_DIR="/home/agent/.cache/mill-healthcheck"
mkdir -p "$STATE_DIR"
# Budget window resets at UTC midnight, not rolling 24h from key
# creation (confirmed directly via /key/info, docs/build-guide.md Part
# 7.3) -- so "today" for alert de-duplication means UTC date, matching
# the window LiteLLM itself uses.
TODAY_UTC=$(date -u +%Y-%m-%d)

declare -A KEYS=(
	[mill-flash]="$MILL_FLASH_KEY"
	[mill-research]="$MILL_RESEARCH_KEY"
	[mill-audit]="$MILL_AUDIT_KEY"
	[mill-mech]="$MILL_MECH_KEY"
)

for alias in "${!KEYS[@]}"; do
	key="${KEYS[$alias]}"
	info=$(curl -s -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
		"http://127.0.0.1:4000/key/info?key=$key")

	spend=$(echo "$info" | jq -r '.info.spend // empty')
	budget=$(echo "$info" | jq -r '.info.max_budget // empty')

	if [ -z "$spend" ] || [ -z "$budget" ] || [ "$budget" = "0" ]; then
		echo "healthcheck: could not read spend/budget for $alias, skipping" >&2
		continue
	fi

	pct=$(awk -v s="$spend" -v b="$budget" 'BEGIN { printf "%.4f", s / b }')
	over=$(awk -v p="$pct" -v t="$THRESHOLD" 'BEGIN { print (p >= t) ? 1 : 0 }')

	STATE_FILE="$STATE_DIR/${alias}-${TODAY_UTC}.alerted"
	if [ "$over" = "1" ] && [ ! -f "$STATE_FILE" ]; then
		pct_display=$(awk -v p="$pct" 'BEGIN { printf "%.0f", p * 100 }')
		curl -s -X POST https://slack.com/api/chat.postMessage \
			-H "Authorization: Bearer $SLACK_BOT_TOKEN" \
			-H "Content-Type: application/json" \
			-d "{\"channel\":\"${SLACK_CHANNEL_MILL}\",\"text\":\"mill-01: \`${alias}\` at ${pct_display}% of its \$${budget}/day budget (\$${spend} spent). Resets at UTC midnight (05:30 IST).\"}" \
			>/dev/null
		touch "$STATE_FILE"
		echo "healthcheck: alerted on $alias at ${pct_display}%"
	fi
done

# Alert state older than 2 days is stale -- keeps the state dir from
# growing forever without needing a separate cleanup job.
find "$STATE_DIR" -name "*.alerted" -mtime +2 -delete 2>/dev/null || true
