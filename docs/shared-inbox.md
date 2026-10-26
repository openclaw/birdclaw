# Shared mentions inbox

Open **Shared mentions** at "/shared-inbox". This is a local-first team triage view, not a replacement for the existing account-ranked Inbox or Mentions pages.

## What is included

- Cached tweets mentioning `@openclaw` or `@steipete`, plus configurable literal name matches. Defaults are OpenClaw, Open Claw, Peter Steinberger and steipete. Matching is case-insensitive with word boundaries; "openclawish" and "@openclaw_spam" do not match.
- One row per canonical tweet ID across all stored accounts and search/mention ingestions. Deleted and superseded tweets are excluded. Multiple targets are badges on the same row.
- Server-persisted read/unread, handled/reopened and report classification. Reading never implicitly resolves a report. Sending a handoff never marks it handled. Opening a single X link leaves explicit reading controls available.
- Target, reading, resolution, classification and literal tweet/author search filters, with bounded 30-row pages. Reading counters ignore the reading filter but respect the other filters.
- Open on X uses only a generated HTTPS X status URL for numeric IDs. Imported non-X IDs remain visible but cannot open or be handed off as X tweets.
- Open unread opens at most five unique unread tweets from the current page, synchronously in the click gesture. Every new window has its opener severed before navigation and uses an explicit no-referrer link. Only successfully created/navigated popups are marked read; blocked popups stay unread. The status message reports both counts. This confirms a popup opened, not that X loaded successfully.

No reads or page mounts perform live X searches. **Sync mentions** explicitly runs the existing Bird/xurl search and ingestion pipeline using the active account, limited to 100 results and at most two pages. Import an archive to establish a real account and configure an existing transport first; demo content is not a live source. Rate-limit handling and credential resolution remain owned by the existing transport layer. Both handle targets and name terms are included in the search. This is a bounded recent search, not a guarantee of complete historical coverage.

**Name matches** changes a SQLite setting for this inbox only, not global OpenClaw configuration. Handles always match. Names are literal, not regexes or X search syntax; use up to 12 names per target, 2–60 characters each. Settings and triage state survive browser/server restarts and are included in Birdclaw's existing private backup contract. Handoff snapshots contain tweet/context text, never the hook token. Treat backup repositories as private archives.

## CLI and JSON

The same underlying state is available without the browser:

```sh
birdclaw --json shared-inbox list --target all --read unread --handled open --limit 30
birdclaw --json shared-inbox read 123456789
birdclaw --json shared-inbox unread 123456789
birdclaw --json shared-inbox handle 123456789
birdclaw --json shared-inbox reopen 123456789
birdclaw --json shared-inbox classify 123456789 bug
birdclaw --json shared-inbox names
birdclaw --json shared-inbox names --openclaw 'OpenClaw,Open Claw' --peter 'Peter Steinberger,steipete'
birdclaw --json shared-inbox sync --account steipete
birdclaw --json shared-inbox send 123456789 --type bug --context 'Reproduction steps'
```

## Real Roboclaw handoff

The server supports OpenClaw's documented **POST /hooks/agent** ingress, not an invented queue or a browser deep-link pretending to deliver work. An operator must supply these server-only environment variables when launching Birdclaw:

| Variable | Meaning |
| --- | --- |
| BIRDCLAW_ROBOCLAW_HOOK_URL | Dedicated agent hook endpoint, e.g. `https://private-gateway.example/hooks/agent`. HTTP is allowed only on loopback. No URL credentials, query or fragment. |
| BIRDCLAW_ROBOCLAW_HOOK_TOKEN | Dedicated OpenClaw hook token, not the Gateway login token. Never put it in browser configuration or a URL. |
| BIRDCLAW_ROBOCLAW_AGENT_ID | Configured agent ID; defaults to `roboclaw`. |

The receiving Gateway must already have its HTTP hooks enabled and allow the selected agent. Use the Gateway's own hook configuration/authorization workflow; this feature does not enable hooks, copy credentials, restart a Gateway or change its configuration. Keep the endpoint behind loopback, a tailnet or a trusted private HTTPS proxy. The receiving agent's tool policy remains the actual access boundary for untrusted tweets.

Before dispatch, stored envelopes are strictly validated against the current configured agent, isolated/non-announcing policy and an eligible local numeric tweet. The outgoing safety scope and name are reconstructed around the saved content as untrusted data; imported JSON cannot override the dispatch operation.

Each explicit send stores one immutable snapshot per tweet: report type (bug or feature), original URL/author/time/text, operator context, matched targets and cached reply/quote context where available. The payload tells the receiving agent to treat source material as data, investigate the scoped report, and create/link a work session with supported tools when available. It explicitly excludes X posting, merging, deployment and global configuration changes. The request uses `sessionMode: isolated`, `deliver: false` and a persisted `Idempotency-Key`. It does not send DMs or post on X.

### Honest delivery states

| State | Meaning / operator action |
| --- | --- |
| pending | Saved on disk, **not delivered**. Missing/invalid hook configuration or a stored-envelope/source validation blocker. After configuring the connection, click **Retry connection** or run the same CLI send. The original payload and key are retained. Nothing retries in the background. |
| sending | Claimed before network I/O. May still be in flight; after a crash its outcome is unknown. Reconcile against OpenClaw's hook logs before any manual intervention. Birdclaw does not resend it. |
| accepted | OpenClaw returned `ok: true` and a run ID. This is admission, **not work completion**, not channel delivery and not proof that a work session was created. |
| failed | A known pre-admission rejection was returned. The fixed categorical HTTP status is shown; upstream diagnostics and credentials are not echoed. No automatic retry or re-dispatch. Fix the connection and reconcile the original handoff with the Gateway operator. |
| uncertain | Timeout, network error, redirect, malformed success, any 5xx/unknown HTTP result or conflicting backup identities. It may already have been admitted. Do not blindly retry. |

Concurrent/repeated sends reuse the stored row. Accepted, in-flight, rejected and uncertain records are deliberately not automatically sent again. The Gateway's own idempotency replay cache is bounded and is not a durable exactly-once guarantee; therefore Birdclaw keeps durable local custody and fails closed on ambiguous outcomes. Reconciliation/reset of rejected or ambiguous rows is an operator maintenance action, not a "retry everything" UI button in phase 1. Backups merge same-identity admission states monotonically (preserving accepted run evidence), and handoff rows with different identities become uncertain rather than permitting duplicate work.

The documented agent-hook admission response contains a run ID, **not a durable Team work-session URL**. This UI therefore shows the accepted run ID and explicitly leaves work completion/session linking unconfirmed. Inspect the receiving Gateway's hook logs by run ID and the work session the receiving agent actually creates. Do not derive a Team session link from a hook UUID. A verified session-link/completion callback is a future integration, not simulated here.

Without a dedicated authorized hook endpoint/token, all independent local functionality is usable and sends remain visibly pending. No production handoff is claimed from tests using a fake HTTP transport.

## Privacy and running locally

The existing Birdclaw loopback/authenticated API guard protects both reads and mutations at `/api/shared-inbox`; responses use `Cache-Control: no-store`. The surface is unavailable in a read-only archive deployment, and mutations respect the existing read-only guard. Do not set a public remote-web bypass to share a preview. Keep cached tweets, SQLite files and credentials out of public assets and screenshots.

For a source checkout with dependencies installed:

```sh
./scripts/bun-canary.sh run --bun build
BIRDCLAW_HOME="$PWD/.openclaw/tmp/shared-preview" ./scripts/bun-canary.sh src/cli.ts --json init --demo
BIRDCLAW_HOME="$PWD/.openclaw/tmp/shared-preview" node bin/birdclaw.mjs serve --host 127.0.0.1 --port 4317
```

Then open `http://127.0.0.1:4317/shared-inbox` from the same host or an authorized private tunnel. This example seeds the built-in **synthetic demo**, not live mentions. Never reuse a production archive for a public preview. For live use choose the intended private BIRDCLAW_HOME instead and configure its account/transport and optional dedicated Roboclaw connection.

Phase 1 has no alerts, hourly polling, on-call rotation, release automation, automatic X replies, production deployment or merge workflow.

## Team-shared deployment

Use the separate [persistent Team mentions-only deployment](team-triage-deployment.md) contract. It requires a fresh dedicated store, isolated purpose-bound xurl authentication HOME, authenticated Team-member proxy headers, a distinct HTTPS app hostname and an operator-owned persistent supervisor. It blocks all other archive/DM/admin/write/MCP routes and does not enable the remote-web bypass. A portal is a temporary bearer preview, not a persistent Team-authenticated service. Real Team ingress and live X verification remain deployment prerequisites, not claims established by synthetic tests.
