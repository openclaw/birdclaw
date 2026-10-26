# Team triage deployment: mcbird.openclaw.ai

The OpenClaw Team mentions inbox runs as Birdclaw's Team mentions-only mode (see
[docs/team-triage-deployment.md](../../docs/team-triage-deployment.md) for the
app's security contract). This directory is everything needed to build, ship and
operate that one deployment.

## How a request flows

```
browser ─▶ Cloudflare Access (OpenClaw ID login, app "mcbird")
        ─▶ Cloudflare Tunnel "birdclaw-team" (rejects requests without a valid Access JWT)
        ─▶ cloudflared on the host ─▶ Caddy 127.0.0.1:8080 (Caddyfile)
        ─▶ Birdclaw 127.0.0.1:4317 (bin/birdclaw-team-triage)
```

Caddy is the identity shim: it requires `Cf-Access-Authenticated-User-Email`,
overwrites `x-birdclaw-triage-token` / `x-birdclaw-triage-user`, strips cookies
and the Access JWT, and caps request bodies at 64 KiB. Nothing on the host
listens publicly and the security group has no inbound rules.

## Shipping a change

1. Merge the change to `main` (PRs required).
2. Tag and push:

   ```sh
   git switch main && git pull
   git tag deploy-$(date -u +%Y%m%d-%H%M)
   git push origin --tags
   ```

3. Watch the **Deploy Team triage** workflow. It builds the release
   (`package-release.sh`), uploads it to S3, and runs `install-release.sh` on the
   host through AWS SSM. A failed health check rolls back automatically.

No AWS or Cloudflare credentials are needed: GitHub authenticates to AWS via
OIDC, and only the `production` environment of `openclaw/birdclaw` can assume
the deploy role. Tags must point at a commit on `main`.

Release tarballs contain only the npm package allowlist (`bin/`, `dist/`,
`package.json`), production `node_modules` pinned by `bun.lock`, and this
directory.

## Where things live

| What | Where |
| --- | --- |
| Host | EC2 `i-061b1847af5758622` (t4g.small, Ubuntu 24.04 arm64), AWS account 631860342038, us-west-1 |
| Shell access | `aws ssm start-session --target i-061b1847af5758622` (no SSH) |
| Releases | `/opt/birdclaw-team/releases/<tag>-<sha>`, active one at `/opt/birdclaw-team/current` |
| Mentions store | `/var/lib/birdclaw-team/mentions/birdclaw.sqlite` (0700 dir, owner `birdclaw`) |
| Auth HOME | `/var/lib/birdclaw-team/auth` |
| Config | `/etc/birdclaw-team/team-triage.env` (copied from `mcbird.env` on every deploy) |
| Proxy token | `/etc/birdclaw-team/proxy-token` + `proxy.env` (generated on first install, never leaves the host) |
| xAI key | 1Password vault `birdclaw-team` → SSM parameter `/birdclaw-team/xai-api-key` → `/etc/birdclaw-team/secrets.env` |
| Tunnel token | 1Password `birdclaw-team` → SSM `/birdclaw-team/cloudflared-tunnel-token` |
| Backups | nightly `birdclaw-team-backup.timer` → `s3://birdclaw-team-releases-631860342038/backups/` (30 days) |
| Logs | `journalctl -u birdclaw-team -u birdclaw-team-proxy -u cloudflared` |

## Common tasks

**Rotate or set the xAI key.** Put the new key in the `birdclaw-team`
1Password vault, then an operator with AWS access runs:

```sh
aws ssm put-parameter --region us-west-1 --overwrite --type SecureString \
  --name /birdclaw-team/xai-api-key --value "file:///dev/stdin" <<<"$KEY"
```

The next deploy picks it up (or re-run the latest deploy workflow).

**Roll back.** Re-run the deploy workflow for an earlier `deploy-*` tag, or on
the host:

```sh
ln -sfn /opt/birdclaw-team/releases/<older> /opt/birdclaw-team/current
systemctl restart birdclaw-team birdclaw-team-proxy
```

**Restore a backup.** Stop `birdclaw-team`, download and gunzip a backup over
`birdclaw.sqlite` (remove `-wal`/`-shm`), `chown birdclaw:birdclaw` and
`chmod 600` it, then start the service.

**Change who can sign in.** Edit the Cloudflare Access application
"OpenClaw Birdclaw Team triage (mcbird)". It admits OpenClaw ID users whose
GitHub role is admin/maintain/triage, plus the "Birdclaw named users" list.

## Host health check

`install-release.sh` checks that an identified request to `/api/status` through
Caddy returns 200 and an unidentified one returns 401. To run the boundary
checks by hand on the host:

```sh
E='Cf-Access-Authenticated-User-Email: probe@mcbird.local'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4317/api/status          # 401
curl -s -o /dev/null -w '%{http_code}\n' -H "$E" http://127.0.0.1:8080/api/status   # 200
curl -s -o /dev/null -w '%{http_code}\n' -H "$E" http://127.0.0.1:8080/api/query    # 404
```
