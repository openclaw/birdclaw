# Persistent Team mentions-only deployment

This is an opt-in app-side security boundary and launch artifact, not an installed service or a delivered Team dashboard. The normal local Birdclaw archive remains unchanged. **Never expose an existing personal Birdclaw database, media root, archive, DM store or shared X authentication HOME to Team users.**

## Required operator infrastructure

1. Allocate a dedicated unprivileged service user, immutable approved application release/runtime and separate persistent directories for the mentions database and service authentication HOME (0700). Do not copy personal archives, DMs, cookies or shared credential files. Use Node within the repository engine contract and the built dist/client, dist/server, dist/cli plus their admitted runtime dependencies. bin/birdclaw-team-triage is the foreground launcher. Deploy an allowlisted release, not the whole task worktree (which can contain unrelated memory/ and private evidence).
2. Allocate a distinct HTTPS **hostname** for the app, separate from the Gateway/Control UI hostname. A different URL path on the Gateway origin is unsafe; the Website dashboard also refuses the connected Gateway hostname, including another port. Set the exact app and Team UI origins in deploy/team-triage.env.example.
3. Configure an identity-aware private reverse proxy to authenticate each viewer as a currently authorized Team member **before** any upstream request. A generic login or possession of a preview URL is not Team membership. Strip client-provided x-birdclaw-triage-token and x-birdclaw-triage-user, then overwrite them with a dedicated internal proxy credential and the verified canonical Team subject/profile ID. Provision a new 32–256-character random URL-safe proxy token in a 0600 regular file, readable only by the service and the operator proxy secret owner. The proxy injects the same value; do not forward the token to the browser, put it in a URL, or reuse a Gateway/X credential. Do not forward Gateway authentication cookies/credentials to the app.
4. Forward to the loopback-only backend. Preserve the browser Origin header. Set a 64 KiB JSON/body limit, short upload timeouts and suitable per-user request limits at the authenticated proxy. Do not enable BIRDCLAW_ALLOW_REMOTE_WEB or remove the existing local guard. The app accepts no localhost bypass in Team mode: all HTML, assets and API requests require both the proxy credential and a verified-user assertion. Writes additionally require the configured app Origin.
5. Run the foreground launcher under an operator-owned persistent supervisor (not a shell tied to this chat): dedicated User, approved WorkingDirectory/ExecStart, private EnvironmentFile, Restart=on-failure, UMask=0077, NoNewPrivileges and filesystem restrictions limiting writes to this service state/auth directories. Provision xurl in the service PATH and the required approved outbound X network access. No nginx, systemd or Gateway config is installed or changed by the application task.
6. Publish the separate HTTPS URL in the Team Website dashboard only after real Team-member/unauthenticated browser verification. Verify Team login, iframe cookie policy, app rendering/assets, both-user triage, and all negative endpoint checks through the real edge. The app sends a frame-ancestors policy permitting only itself and the configured Team UI origin; sign-in flows may still require an initial top-level visit.

## Initialize only a new dedicated store

With the prepared release and service-owned directories, run as the dedicated service user (paths are examples):

```sh
BIRDCLAW_HOME=/var/lib/birdclaw-team/mentions BIRDCLAW_TEST_SEED_DEMO_DATA=0 \
  node /opt/birdclaw-team/bin/birdclaw.mjs --json shared-inbox init-team
```

This command refuses adopting a populated unmarked store. It records a local purpose marker in sync_cache (deliberately not exported in portable backups). Startup validates that marker and absence of DMs, saved collections, moderation, actions and other private archive state **before** migrations/listening. No demo is seeded. A restored generic backup is not silently admitted; initialize/review a dedicated store instead. Server restarts preserve shared read/handled/classification state and coverage on the same disk database.

Before any xurl login, explicitly admit a new empty authentication HOME (a populated personal/shared home is refused):

```sh
BIRDCLAW_HOME=/var/lib/birdclaw-team/mentions BIRDCLAW_TRIAGE_AUTH_HOME=/var/lib/birdclaw-team/auth \
  node /opt/birdclaw-team/bin/birdclaw.mjs --json shared-inbox init-team-auth-home
```

Its private purpose marker is bound to the dedicated store path and validated at startup. Do not copy that marker or credentials from another installation.

Apply the private environment configuration from deploy/team-triage.env.example, then run the built release:

```sh
bash /opt/birdclaw-team/bin/birdclaw-team-triage
```

The launcher honors PORT/BIRDCLAW_PORT (default 4317), binds only 127.0.0.1, uses the isolated authentication HOME, disables live X writes/profile lookup and backup auto-sync, and never installs a service. Proxy-token configuration, exact separate HTTPS origins and private state/auth directory permissions fail closed. Inherited browser AUTH_TOKEN/CT0 cookies are refused.

## Least-privilege app surface

Team mode allows only the shared inbox page, its compiled assets, a minimal status envelope and the shared-inbox API. The status envelope has no account list, archive paths, transport diagnostics or private counts. Every other archive, DM, query, write/action, admin, profile, media/proxy and MCP route is denied before the normal handler/static/SSR path. The UI omits archive navigation, account switching and name-match administration. Team users can mark read/unread, handle/reopen and classify reports; these are shared server states, not per-browser states. Local state refresh is bounded to visible-page 15-second reads and never fetches X automatically.

Names remain operator-managed through the local CLI. Handoff is disabled for Team users unless the operator explicitly enables BIRDCLAW_TRIAGE_ALLOW_HANDOFF=1 and separately configures the authorized agent hook. That flag does not grant X/DM writes, merging, deployment or configuration authority. Existing immutable/idempotent handoff safety still applies.

## Dedicated X read-source readiness

The host executable existing somewhere is not an authorized login. Provision a **dedicated read-only xurl OAuth2 service account/app** under the isolated service authentication HOME through the supported xurl login workflow. Do not borrow/copy the current shared host user's xurl or browser credentials. This task does not provision or inspect those secrets.

Bind the service account metadata only after the operator knows its verified handle and numeric X user ID:

```sh
BIRDCLAW_HOME=/var/lib/birdclaw-team/mentions BIRDCLAW_TEST_SEED_DEMO_DATA=0 \
  node /opt/birdclaw-team/bin/birdclaw.mjs --json shared-inbox configure-team-account SERVICE_HANDLE NUMERIC_USER_ID
```

This is metadata, **not proof of login**. Then set BIRDCLAW_TRIAGE_SYNC_ACCOUNT=team-triage, BIRDCLAW_XURL_OAUTH2_APP to its explicit dedicated app label and BIRDCLAW_XURL_OAUTH2_USERNAME to that exact handle in the service environment. Manual Team sync first verifies the fresh xurl identity against the pinned handle/ID, then pins that exact app/account to every xurl search page (no default-context discovery, automatic Bird or other-account fallback), a six-day recent window, at most 100 results/two pages and a persisted five-minute minimum between attempts. Team clients cannot override the account. Identity preflight is interrupted after 20 seconds and the complete Team sync job after 60 seconds; failed/interrupted work releases overlap custody and does not become a verified connection. There is no hourly job or automatic X polling.

The UI distinguishes unconfigured source, never verified, running, successful bounded read (including a true zero-result read), failed, cache-only and interrupted reads. Last attempt and last verified live-sync times survive restart. Row count is never presented as connection/coverage proof; a successful bounded read is not complete historical or continuous coverage. No provider diagnostic/token text is exposed. Coverage is operational sync-cache metadata and intentionally resets on a generic backup restore, rather than claiming that another installation's X login is live.

## Verification boundary and service lifetime

App tests use synthetic proxy/user assertions and public-looking fixture reports, not actual Team SSO or live X. Operator verification of Team membership enforcement and the real account remains required. An installed supervisor and persistent storage must survive Gateway restart. **Portals are temporary bearer-auth previews, end on Gateway restart, do not supply Team identity and are not this persistent deployment.** A Website dashboard loads the app in the viewer's browser; it does not proxy or authenticate the app. Do not claim a live dashboard from a worker-local render, a portal receipt, or no-data demo.

## Optional Grok `x_search` read source (no direct X API)

Choose **one** source explicitly with `BIRDCLAW_TRIAGE_SOURCE=grok` (existing default: `xurl`). Grok uses the xAI Responses API at the hard-coded `https://api.x.ai/v1/responses`, model `grok-4.7`, and only the server-side `x_search` tool. It never calls the direct X API, discovers OAuth accounts, or falls back to Bird/xurl. No X login, numeric X user ID or xurl installation is required for this source; steps 5 and the dedicated X account section above apply only to xurl. All separate-origin, Team identity proxy, private dedicated store/HOME, purpose-marker, write-disable and supervisor requirements still apply. The legacy HOME purpose marker name is retained for compatibility and is not a claim of X authentication.

After initializing the dedicated store and isolated HOME as above, configure local ingestion ownership (not an X identity or authentication proof):

```sh
BIRDCLAW_HOME=/var/lib/birdclaw-team/mentions BIRDCLAW_TEST_SEED_DEMO_DATA=0 \
  node /opt/birdclaw-team/bin/birdclaw.mjs --json shared-inbox configure-team-grok-source
```

Set `BIRDCLAW_TRIAGE_SOURCE=grok` and `BIRDCLAW_TRIAGE_SYNC_ACCOUNT=team-triage` in the approved service configuration. Do not put the xAI key in this repository, example env, browser, logs or command arguments. Use a **dedicated protected** `BIRDCLAW_XAI_API_KEY`, bound only to `api.x.ai`.

### Supported protected-key consumer

OpenClaw's protected store injects only opaque environment sentinels into **Gateway-hosted exec** with `secrets.egressProxy.enabled=true`; Node 26 global fetch honors its injected `NODE_USE_ENV_PROXY=1`, authenticated proxy and CA environment. The proxy substitutes the real key only at HTTPS egress to the bound hostname. Native Codex shell, remote node, Bun and an ordinary external supervisor do **not** automatically receive this protected secret. Never copy a sentinel, read/export the key, disable TLS, or use a plaintext fallback. A credential saved after a turn's first managed command requires a fresh turn/grant. A future persistent deployment needs an operator-approved supported secret consumer/egress integration; merely saving the key does not provision that service. This implementation neither installs that integration nor deploys the app.

### Search and evidence limits

Manual sync retains the persisted five-minute cooldown, overlap guard and 60-second job deadline. Grok fetch has a 45-second abort, refuses redirects, caps response bytes at 2 MB, tool turns at two and accepted posts at 100. Date filters use UTC days as required by xAI; snowflake-derived timestamps are additionally checked against the exact six-day sync interval. Turn/output limits are not a hard dollar or fetched-post budget; xAI bills model tokens and fetched items. There is no automatic polling or posting.

Only completed responses with an executed X-search tool and valid JSON are accepted. Each imported post must have a provider-supplied X status citation; malformed, uncited, off-host and out-of-window results fail closed before persistence. Empty results require an executed search too. Grok-extracted text and handles remain **model extraction**, not authoritative/verbatim X API records; citations do not independently prove exact quotations or identity. Handles use explicitly synthetic `grok-handle:` profile IDs, never invented numeric X identities. A collision with a different existing profile fails closed rather than merging identities. Existing tweet records and shared read/handled/classification state are not overwritten; provenance is recorded as `grok`. Coverage explicitly warns that results can omit/misquote posts and are not continuous or exhaustive monitoring.

Fixture tests verify the adapter and Team boundary; a real key/model/tool test and real authenticated edge verification are separate, and must not be inferred from fixture success.
