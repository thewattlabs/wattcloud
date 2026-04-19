#!/usr/bin/env bash
# release.sh — build Wattcloud image, push to GHCR, emit the digest.
#
# Usage: scripts/release.sh <version-tag>
#   e.g. scripts/release.sh v0.1.0
#
# Prerequisite: you have pushed an SSH-signed commit that matches the tag, AND
# you have run `docker login ghcr.io` with a PAT that has write:packages scope.
#
# Output: prints the image digest (sha256:...) to stdout on success. Capture
# this and pass it to scripts/update.sh on the VPS for digest-pinned rollout.

set -euo pipefail

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "usage: $0 <version-tag>" >&2
  exit 2
fi

IMAGE="ghcr.io/wattzupbyte/wattcloud"
FULL_TAG="${IMAGE}:${TAG}"

# Build byo-server image (the Rust binary carries the SPA bundle in /dist).
cd "$(dirname "$0")/.."
docker build -t "$FULL_TAG" -f byo-server/Dockerfile .

docker push "$FULL_TAG"

# Resolve to a sha256 digest so compose can pin by immutable reference.
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$FULL_TAG")

echo
echo "Pushed: $FULL_TAG"
echo "Digest: $DIGEST"
echo
echo "On the VPS, run:"
echo "  scripts/update.sh $DIGEST"
