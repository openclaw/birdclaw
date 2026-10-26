#!/usr/bin/env bash
# Install one Birdclaw Team triage release on the host, then switch traffic to it.
#
# Usage (as root, normally via AWS SSM from the deploy workflow):
#   install-release.sh <release.tgz> <expected-sha256> <release-id>
#
# The tarball is the allowlisted npm package (bin/, dist/, package.json) plus
# production node_modules and deploy/team-triage/. Steps:
#   1. verify and unpack into /opt/birdclaw-team/releases/<release-id> (read-only)
#   2. create the proxy token on first install; refresh the xAI key from SSM
#   3. initialize the dedicated store on first install only
#   4. activate the release: its unit files and env, the current symlink, restarts
#   5. health-check through the identity shim; on failure re-activate the
#      previous release (including its units and env) and health-check that
#   6. enable the nightly store backup and prune old releases
set -euo pipefail

tarball="${1:?release tarball path}"
expected_sha="${2:?expected sha256}"
release_id="${3:?release id}"

root=/opt/birdclaw-team
releases="$root/releases"
etc=/etc/birdclaw-team
state=/var/lib/birdclaw-team
region=us-west-1
keep_releases=5

log() { echo "[install-release] $*"; }

[[ "$release_id" =~ ^[A-Za-z0-9._-]{1,100}$ ]] || { log "invalid release id"; exit 2; }
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || { log "invalid sha256"; exit 2; }
echo "$expected_sha  $tarball" | sha256sum -c --quiet -

# 1. Unpack into a fresh, root-owned, read-only release directory. Release ids
#    include the commit, so an existing directory is the same release and is
#    reused rather than replaced underneath a running service.
target="$releases/$release_id"
if [[ -d "$target" ]]; then
	log "release $release_id already present; reusing it"
else
	staging="$(mktemp -d "$releases/.staging.XXXXXX")"
	trap 'rm -rf "$staging"' EXIT
	tar -xzf "$tarball" -C "$staging"
	chown -R root:root "$staging"
	chmod -R go-w,a+rX "$staging"
	mv -T "$staging" "$target"
	trap - EXIT
	log "unpacked $release_id"
fi
/opt/node/bin/node "$target/bin/birdclaw.mjs" --version >/dev/null

# 2a. Shared proxy token: one copy for the app (birdclaw, 0600) and one env
#     file for the shim (root, 0600, read by systemd before dropping privileges).
if [[ ! -s "$etc/proxy-token" ]]; then
	token="$(head -c 48 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '=')"
	install -o birdclaw -g birdclaw -m 0600 /dev/null "$etc/proxy-token"
	printf '%s\n' "$token" > "$etc/proxy-token"
	install -o root -g root -m 0600 /dev/null "$etc/proxy.env"
	printf 'BIRDCLAW_TRIAGE_PROXY_TOKEN=%s\n' "$token" > "$etc/proxy.env"
	unset token
	log "generated proxy token"
fi

# 2b. xAI key: SSM Parameter Store is the host's source (1Password is the human
#     source). A missing parameter keeps whatever secrets.env already holds.
if key="$(aws ssm get-parameter --region "$region" --name /birdclaw-team/xai-api-key \
	--with-decryption --query Parameter.Value --output text 2>/dev/null)"; then
	install -o root -g root -m 0600 /dev/null "$etc/secrets.env.new"
	printf 'BIRDCLAW_XAI_API_KEY=%s\n' "$key" > "$etc/secrets.env.new"
	mv -f "$etc/secrets.env.new" "$etc/secrets.env"
	log "refreshed xAI key from SSM"
else
	log "no /birdclaw-team/xai-api-key parameter; Grok sync stays unavailable"
fi
unset key

# 3. First install only: create the dedicated store, auth HOME marker and Grok
#    source row. These commands refuse to adopt any pre-existing private data.
if [[ ! -e "$state/mentions/birdclaw.sqlite" ]]; then
	cli=(/opt/node/bin/node "$target/bin/birdclaw.mjs" --json shared-inbox)
	run_as() { (umask 077 && runuser -u birdclaw -- env -i PATH=/usr/bin:/bin "$@"); }
	run_as BIRDCLAW_HOME="$state/mentions" BIRDCLAW_TEST_SEED_DEMO_DATA=0 "${cli[@]}" init-team
	run_as BIRDCLAW_HOME="$state/mentions" BIRDCLAW_TRIAGE_AUTH_HOME="$state/auth" "${cli[@]}" init-team-auth-home
	run_as BIRDCLAW_HOME="$state/mentions" BIRDCLAW_TEST_SEED_DEMO_DATA=0 "${cli[@]}" configure-team-grok-source
	log "initialized dedicated Team store"
fi

# 4. Activate a release: install its unit files and non-secret env, switch the
#    current symlink atomically and restart. Returns non-zero instead of
#    exiting so a failed activation still reaches the rollback below.
activate() {
	local release="$1" dir="$1/deploy/team-triage"
	install -m 0644 "$dir/birdclaw-team.service" "$dir/birdclaw-team-proxy.service" \
		"$dir/birdclaw-team-backup.service" "$dir/birdclaw-team-backup.timer" \
		/etc/systemd/system/ || return 1
	install -o root -g birdclaw -m 0640 "$dir/mcbird.env" "$etc/team-triage.env" || return 1
	systemctl daemon-reload || return 1
	ln -sfn "$release" "$root/.current.new" && mv -T "$root/.current.new" "$root/current" || return 1
	systemctl enable --quiet birdclaw-team.service birdclaw-team-proxy.service || return 1
	systemctl restart birdclaw-team.service birdclaw-team-proxy.service || return 1
}

# 5. Health: an identified request must reach the app; an unidentified one
#    must be refused by the shim.
healthy() {
	local code
	for _ in $(seq 1 30); do
		code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
			-H 'Cf-Access-Authenticated-User-Email: deploy-healthcheck@mcbird.local' \
			http://127.0.0.1:8080/api/status || true)"
		if [[ "$code" == 200 ]]; then
			[[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8080/api/status)" == 401 ]]
			return
		fi
		sleep 1
	done
	return 1
}

previous="$(readlink -f "$root/current" 2>/dev/null || true)"
if ! { activate "$target" && healthy; }; then
	log "activation or health check failed for $release_id"
	journalctl -u birdclaw-team.service -u birdclaw-team-proxy.service -n 40 --no-pager || true
	if [[ -n "$previous" && "$previous" != "$target" && -d "$previous" ]]; then
		if activate "$previous" && healthy; then
			log "rolled back to $(basename "$previous") (healthy)"
		else
			log "ROLLBACK FAILED: $(basename "$previous") is not healthy either; service is down"
		fi
	else
		log "no previous release to roll back to"
	fi
	exit 1
fi
log "healthy: $release_id"

# 6. Backups and pruning: keep the newest releases plus whatever is current.
systemctl enable --now --quiet birdclaw-team-backup.timer
current="$(readlink -f "$root/current")"
find "$releases" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@ %p\n' |
	sort -rn | cut -d' ' -f2- | tail -n +$((keep_releases + 1)) | while read -r old; do
	[[ "$old" == "$current" ]] || rm -rf -- "$old"
done
