#!/usr/bin/env bash
# update.sh — VPS-side: pin compose to a new digest, pull, restart, health-check.
#
# Usage: scripts/update.sh <image-digest>
#   e.g. scripts/update.sh ghcr.io/wattzupbyte/wattcloud@sha256:abc123...
#
# Prerequisite: GHCR docker login has been configured (deploy-vps.sh handles
# this at provision time, persisting ~/.docker/config.json as appuser).

set -euo pipefail

DIGEST="${1:-}"
if [[ -z "$DIGEST" ]]; then
  echo "usage: $0 <image-digest>   e.g. ghcr.io/wattzupbyte/wattcloud@sha256:..." >&2
  exit 2
fi

if ! [[ "$DIGEST" =~ ^ghcr\.io/wattzupbyte/wattcloud@sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: digest must be of the form ghcr.io/wattzupbyte/wattcloud@sha256:<64-hex>" >&2
  echo "Got: $DIGEST" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

# Update the image ref in the compose file. The sed is idempotent — running
# twice with the same digest is a no-op.
if ! [[ -f docker-compose.byo-prod.yml ]]; then
  echo "ERROR: docker-compose.byo-prod.yml not found" >&2
  exit 2
fi

# Replace the byo-server image line (accepting either :tag or @sha256 forms).
sed -i -E "s|(^\s*image:\s*).*|\1${DIGEST}|" docker-compose.byo-prod.yml

echo "Pinned compose image to: $DIGEST"
docker compose -f docker-compose.byo-prod.yml pull
docker compose -f docker-compose.byo-prod.yml up -d

# Give it a moment, then hit /health.
sleep 5
if curl -fsS http://127.0.0.1:8443/health >/dev/null 2>&1; then
  echo "OK: byo-server /health returned 200."
else
  echo "WARN: /health probe failed — check 'docker compose logs byo-server'." >&2
  exit 1
fi
