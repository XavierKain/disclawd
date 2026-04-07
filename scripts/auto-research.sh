#!/bin/bash
# DisClawd Auto-Research — runs weekly via cron
# Posts a research prompt to #research channel via the Discord bot webhook
# The DisClawd bot will process it as a normal message

set -euo pipefail

WEBHOOK_URL="${DISCORD_RESEARCH_WEBHOOK:-}"
DISCLAWD_DIR="/home/xavier/xklip/disclawd"

if [ -z "$WEBHOOK_URL" ]; then
  echo "ERROR: DISCORD_RESEARCH_WEBHOOK not set"
  exit 1
fi

# Build the research prompt
RESEARCH_PROMPT=$(cat <<'PROMPT'
Weekly DisClawd auto-research. Analyze the following and report back:

## 1. Claude Code Updates
- Check https://docs.anthropic.com/en/docs/claude-code for recent changelog entries
- Any new CLI flags, features, or breaking changes?

## 2. Discord.js Updates
- Check discord.js releases for v14.x updates
- New components, interactions, or API changes?

## 3. Agent Framework Trends
- What are the trending repos on GitHub for: AI agents, Claude tools, coding assistants?
- Any new patterns worth adopting?

## 4. DisClawd Improvement Proposals
Based on your findings, propose max 3 concrete improvements:
- Each must include: problem, solution, estimated effort (hours), impact (high/medium/low)
- Focus on things that would make DisClawd more useful or competitive

## Format
Use markdown. Start each proposal with "### Proposal N:" so Xavier can easily approve by reacting.
Post en français pour les recommandations.
PROMPT
)

# Send to Discord via webhook (bot will pick it up and spawn a Claude session)
curl -s -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg content "$RESEARCH_PROMPT" '{content: $content}')" \
  > /dev/null

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Research prompt posted to #research"
