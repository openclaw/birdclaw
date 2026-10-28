#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname "$script_dir")
# shellcheck source=toolchains/bun-canary.conf
. "$root/toolchains/bun-canary.conf"

fail() {
	printf 'birdclaw Bun install: %s\n' "$*" >&2
	exit 1
}

sha256_file() {
	if command -v shasum >/dev/null 2>&1; then
		result=$(shasum -a 256 "$1")
	elif command -v sha256sum >/dev/null 2>&1; then
		result=$(sha256sum "$1")
	else
		fail "shasum or sha256sum is required"
	fi
	printf '%s\n' "${result%% *}"
}

verify_binary() {
	candidate=$1
	expected_sha=$2
	[ -x "$candidate" ] || fail "missing executable $candidate"
	actual_sha=$(sha256_file "$candidate")
	[ "$actual_sha" = "$expected_sha" ] ||
		fail "binary checksum mismatch: expected $expected_sha, got $actual_sha"
	actual_revision=$("$candidate" --revision)
	[ "$actual_revision" = "$BUN_CANARY_REVISION" ] ||
		fail "revision mismatch: expected $BUN_CANARY_REVISION, got $actual_revision"
}

case "$(uname -s)-$(uname -m)" in
	Darwin-arm64)
		asset_name=$BUN_CANARY_DARWIN_ARM64_ASSET_NAME
		artifact_url=$BUN_CANARY_DARWIN_ARM64_ARTIFACT_URL
		archive_sha=$BUN_CANARY_DARWIN_ARM64_ARCHIVE_SHA256
		binary_sha=$BUN_CANARY_DARWIN_ARM64_BINARY_SHA256
		;;
	Linux-x86_64)
		asset_name=$BUN_CANARY_LINUX_X64_ASSET_NAME
		artifact_url=$BUN_CANARY_LINUX_X64_ARTIFACT_URL
		archive_sha=$BUN_CANARY_LINUX_X64_ARCHIVE_SHA256
		binary_sha=$BUN_CANARY_LINUX_X64_BINARY_SHA256
		;;
	*)
		fail "unsupported platform $(uname -s)-$(uname -m)"
		;;
esac

install_root=${BIRDCLAW_BUN_INSTALL_ROOT:-"$root/.toolchains/bun/$BUN_CANARY_SOURCE_SHA"}
binary="$install_root/bin/bun"
if [ -e "$binary" ]; then
	verify_binary "$binary" "$binary_sha"
	printf '%s\n' "$binary"
	exit 0
fi

command -v unzip >/dev/null 2>&1 || fail "unzip is required"
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/birdclaw-bun-canary.XXXXXX")
cleanup() {
	rm -rf "$temp_dir"
}
trap cleanup EXIT HUP INT TERM
archive="$temp_dir/$asset_name"

if [ -n "${BIRDCLAW_BUN_ARCHIVE:-}" ]; then
	case "$BIRDCLAW_BUN_ARCHIVE" in
		http://*|https://*)
			command -v curl >/dev/null 2>&1 || fail "curl is required"
			curl -fsSL --retry 3 --retry-delay 2 "$BIRDCLAW_BUN_ARCHIVE" -o "$archive"
			;;
		*)
			[ -f "$BIRDCLAW_BUN_ARCHIVE" ] ||
				fail "archive does not exist: $BIRDCLAW_BUN_ARCHIVE"
			cp "$BIRDCLAW_BUN_ARCHIVE" "$archive"
			;;
	esac
else
	command -v curl >/dev/null 2>&1 || fail "curl is required"
	download_url=${BIRDCLAW_BUN_DOWNLOAD_URL:-$artifact_url}
	if ! curl -fsSL --retry 3 --retry-delay 2 "$download_url" -o "$archive"; then
		fail "could not download the pinned OpenClaw release artifact; set BIRDCLAW_BUN_ARCHIVE to a cached copy"
	fi
fi

actual_archive_sha=$(sha256_file "$archive")
if [ "$actual_archive_sha" != "$archive_sha" ]; then
	fail "archive checksum mismatch: expected $archive_sha, got $actual_archive_sha"
fi

unzip -q "$archive" -d "$temp_dir/extracted"
archive_dir=${asset_name%.zip}
candidate="$temp_dir/extracted/$archive_dir/bun"
verify_binary "$candidate" "$binary_sha"

mkdir -p "$install_root/bin"
temporary_binary="$install_root/bin/.bun.$$"
cp "$candidate" "$temporary_binary"
chmod 755 "$temporary_binary"
mv "$temporary_binary" "$binary"
verify_binary "$binary" "$binary_sha"
printf '%s\n' "$binary"
