#!/bin/bash
# Deploy DisClawd landing page to o2switch
# Subdomain: disclawd.xavier-kain.fr

set -euo pipefail

WEB_DIR="/home/xavier/xklip/disclawd/web"
SSH_KEY="/home/xavier/.ssh/o2switch_key"
REMOTE_USER="wito4771"
REMOTE_HOST="bretelle.o2switch.net"
REMOTE_DIR="/home/wito4771/disclawd.xavier-kain.fr"

if [ ! -d "$WEB_DIR" ]; then
  echo "ERROR: $WEB_DIR does not exist"
  exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Deploying to disclawd.xavier-kain.fr..."

# Ensure remote dir exists
ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" "mkdir -p $REMOTE_DIR" 2>/dev/null

# Rsync files
rsync -avz --delete \
  -e "ssh -i $SSH_KEY" \
  "$WEB_DIR/" \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/" \
  2>&1 | tail -5

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Deploy complete!"

# Verify
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://disclawd.xavier-kain.fr/" 2>/dev/null || echo "000")
echo "HTTP status: $HTTP_CODE"

if [ "$HTTP_CODE" = "200" ]; then
  echo "Site live at https://disclawd.xavier-kain.fr/"
else
  echo "WARNING: Site may not be live yet (SSL propagation can take a few minutes)"
fi
