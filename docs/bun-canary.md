---
title: Pinned Bun 1.4
description: "Exact patched OpenClaw Bun 1.4 Rust-port build, compatibility constraints, verification, and rollback boundaries."
---

# Pinned Bun 1.4

Birdclaw source development and source-backed deployments select one checksum-pinned OpenClaw Bun 1.4.4 build. The existing `bun-canary` filenames remain the installation entry points; they do not select a floating canary.

## Exact build

| Field | Value |
| --- | --- |
| Runtime revision | `1.4.4-canary.1+191755ec1` |
| Source commit | `191755ec115ece3dd642eba3cb0143cecb5e5d7a` |
| Release | `openclaw-v1.4.4-20261026-191755ec11-webkit-b82bc917e9` |
| WebKit prebuilt | `b82bc917e99110b61c3a21202d6def7457aa194c` |
| macOS arm64 archive SHA-256 | `d2fe652e031b44f9971c8184ae688f24f06b885a7f22bf082b15cb6ab524de51` |
| macOS arm64 binary SHA-256 | `c6326ed34d59a7f648b9871a077923f5d9a5cc1c54d25629d1ff70648c51953c` |
| Linux x64 archive SHA-256 | `a59df8273c232782c16a6c0e680511becd9a49ba08fa6a1adc7baea1a632de0b` |
| Linux x64 binary SHA-256 | `0cef667e2f3fd465b6429904ed074381a679be379ec44fa42b5f460ed118b2b8` |

The machine-readable source of truth is `toolchains/bun-canary.conf`. `scripts/install-bun-canary.sh` downloads the exact [published OpenClaw fork](https://github.com/openclaw/bun/releases/tag/openclaw-v1.4.4-20261026-191755ec11-webkit-b82bc917e9), verifies both checksums, then requires the exact `bun --revision`. A cached archive can be supplied through `BIRDCLAW_BUN_ARCHIVE`.

The fork includes the upstream compromised-key rejection and additional enforcement for persisted TLS sessions. Stock Bun 1.4.4 alone does not provide the same saved-session remediation. Do not replace the selected archive with stock stable or a rolling canary. If the exact release artifact is unavailable, installation fails closed and requests a cached exact archive.

## What “Rust port” means

Bun 1.4 is the first release line after Bun's Zig-to-Rust port. It preserves Bun's architecture rather than becoming a pure-Rust runtime: JavaScriptCore, SQLite, BoringSSL, and other native components remain embedded. Birdclaw describes it as the Rust-port Bun 1.4 canary, not as an all-Rust stack.

## Compatibility constraints

### Node contract

The npm and Homebrew package remains a Node CLI with `#!/usr/bin/env node` and `engines.node: >=26.5.1 <27`. CI runs Node coverage and builds on the maintained Node 26 version in `.node-version`, and installed-package smoke uses that patched Node 26 version as well as the exact Bun binary. The public `>=26.5.1 <27` range remains a compatibility contract, not a security recommendation: use Node 26.12.1 or newer patched Node 26.

Bun is identified through `process.versions.bun` and its own exact revision, independently of its reported Node compatibility version.

### SQLite and WAL

Birdclaw keeps the shared `node:sqlite` adapter. Bun's implementation supports the APIs Birdclaw uses, including FTS5, WAL, transactions, iterators, and BLOBs.

SQLite WAL readers sometimes need to create `-wal`/`-shm` coordination files after a clean process exit. Birdclaw therefore opens managed readers normally under Bun and immediately applies `pragma query_only = on`; Node keeps its native read-only open. Both connections remain unable to execute application writes or DDL, while Bun's SQLite library can establish WAL coordination. Dual-runtime package smoke covers MCP startup from a clean installed database, the case that exposed this constraint.

### Tests and coverage

The constraints below record the original f972c287f migration evidence. They are retained conservatively; they do not establish fresh performance or complete compatibility qualification of the selected 1.4.4 fork. Keep the pins and assertions until their owning checks demonstrate a supported change.

Vitest runs under both runtimes. Bun needs `zod` inlined through Vitest's dependency server to avoid an externalization interop failure in the exact canary.

The test environment pins jsdom 30.0.1. With jsdom 30.1.1 and Vitest 5.0.1, jsdom 30.1.2 and Vitest 5.0.3, or jsdom 30.1.3 and Vitest 5.0.5, DOM workers cannot initialize under the exact Bun canary: window error handling fails the `EventTarget.addEventListener` receiver check. Keep the pin until that runtime combination passes the DOM tests.

Bun uses JavaScriptCore, so the primary Bun coverage gate uses Istanbul. The same suite reports 79.08% Istanbul branch coverage versus 80.20% under Node/V8 because the providers count generated/default branches differently. Birdclaw keeps the original 80% Node/V8 branch gate and an explicit 79% Bun/Istanbul gate rather than disguising the provider change; line, statement, and function thresholds remain 85%. Coverage runs get a 30-second per-test ceiling for instrumentation overhead, while ordinary tests retain the tighter 10-second ceiling.

Playwright 1.64.0 is not generally documented as a Bun-supported runtime, but its full Birdclaw Chromium suite passes on this exact canary. CI pins that observed combination and tests the built production server, rather than claiming compatibility with arbitrary Bun versions.

### Environment and telemetry

Direct Bun execution loads `.env` files unless disabled. Birdclaw's wrapper and launchd examples always pass `--no-env-file`. The wrapper also defaults `DO_NOT_TRACK=1` so Bun does not upload crash reports from private local archives.

## Verification

```bash
./scripts/bun-canary.sh scripts/verify-bun-canary.mjs
./scripts/bun-canary.sh install --frozen-lockfile
./scripts/bun-canary.sh run --bun check
./scripts/bun-canary.sh run --bun coverage
./scripts/bun-canary.sh run --bun build
./scripts/bun-canary.sh run --bun e2e
```

Node compatibility:

```bash
fnm use
./scripts/bun-canary.sh run coverage:node
./scripts/bun-canary.sh run build:node
```

Installed-package proof creates npm and Bun tarballs with identical file lists, installs the npm tarball, then runs CLI, SQLite, SSR, static assets, MCP, and SIGTERM checks under both runtimes:

```bash
BIRDCLAW_NODE_BIN="$(command -v node)" \
  ./scripts/bun-canary.sh scripts/package-smoke.mjs --json
```

## Historical performance comparison

The published figures below apply only to the retired `f972c287f` canary. They must not be read as performance claims for the selected 1.4.4 fork. New qualification must identify the exact artifact and its own samples.

`runtime-perf.mjs` records raw cold CLI, server-listening, first-response, and RSS samples with median, p95, deterministic bootstrap intervals, runtime identity, artifact digests, physical database hashes, and WAL-aware logical SQLite hashes. Run it separately for the landed pre-migration artifact on Node (A), the migration artifact on Node (B), and the same migration artifact on Bun (C):

```bash
./scripts/bun-canary.sh scripts/runtime-perf.mjs \
  --label=migration-bun \
  --runtime="$(./scripts/install-bun-canary.sh)" \
  --runtime-arg=--no-env-file \
  --entry=bin/birdclaw.mjs \
  --home=/tmp/birdclaw-perf-home \
  --iterations=30 > runtime-perf-bun.json
```

Use separate byte-identical copies of the input database for each cell. A→B exposes build/package regressions; B→C isolates the runtime effect. `browser-perf.mjs` accepts the same explicit runtime/entry controls and runs against the built production server instead of a Vite development server.

The accepted comparison ran on an otherwise idle Apple Silicon M4 Max host with macOS 27.0, Node 26.7.0, byte-identical demo databases, and 30 cold runtime samples per cell. Each browser scenario also used 30 samples per cell after its request vector was made deterministic.

| Metric | Migration Node vs landed Node | Bun vs same migration artifact on Node |
| --- | ---: | ---: |
| CLI startup median | 0.4% faster | 44.0% faster |
| Server listening median | 1.2% faster | 44.4% faster |
| First response median | 0.6% faster | 52.5% faster |
| RSS median | 0.7% lower | 18.8% lower |

Across the six browser scenarios, Bun changed ready medians by -5.9% to +0.3% and action medians by -2.8% to +0.1%; the worst ready/action p95 regression was +0.4%. Endpoint counts, query scoping, row counts, preview counts, the deferred links prefetch, and the cached Home round trip matched exactly. WAL-aware logical database hashes were unchanged in every runtime cell. The sanitized summary is checked in at `docs/benchmarks/bun-canary-f972c287f-summary.json`; bounded raw runtime and browser shards live beside it.

## Production rollback boundary

Source-backed deployments install the pinned build in a revision-specific side-by-side path. It does not overwrite `/opt/homebrew/bin/bun`, the stable Bun channel, the Node 26 runtime, or the saved Node LaunchAgent plist. Rollback restores the previous Node command vector and restarts the existing service; no database or package-manager downgrade is required.
