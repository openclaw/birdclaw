#!/usr/bin/env bash
# Build the allowlisted Team triage release tarball from a clean checkout.
#
# Usage: deploy/team-triage/package-release.sh <output-dir>
# Writes <output-dir>/release.tgz and <output-dir>/release.sha256.
#
# The release holds only what the service needs: the npm package file list
# (bin/, dist/, package.json, docs), production dependencies resolved from
# bun.lock, and deploy/team-triage/. Never the whole worktree.
set -euo pipefail

out="${1:?output directory}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Install with the pinned Bun toolchain, then build with Node (the service runtime).
./scripts/bun-canary.sh install --frozen-lockfile
./scripts/bun-canary.sh run build:node

# Pack exactly the npm "files" allowlist and unpack it as the release root.
./scripts/bun-canary.sh pm pack --ignore-scripts --destination "$work"
tar -xzf "$work"/*.tgz -C "$work"
release="$work/package"

# Production dependencies only, pinned by the repository lockfile.
cp bun.lock "$release/"
(cd "$release" && "$repo/scripts/bun-canary.sh" install --production --frozen-lockfile --ignore-scripts)
rm -f "$release/bun.lock"

# The host is arm64 and this build may run elsewhere: refuse native addons.
if find "$release/node_modules" -name '*.node' -type f | grep -q .; then
	echo "native addons found in production dependencies; build on the target architecture" >&2
	exit 1
fi

mkdir -p "$release/deploy"
cp -R deploy/team-triage "$release/deploy/"

tar -czf "$out/release.tgz" -C "$release" .
sha256sum "$out/release.tgz" | cut -d' ' -f1 > "$out/release.sha256"
echo "release: $out/release.tgz ($(du -h "$out/release.tgz" | cut -f1), sha256 $(cat "$out/release.sha256"))"
