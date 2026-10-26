import { timingSafeEqual } from "node:crypto";
import {
	lstatSync,
	readFileSync,
	readdirSync,
	mkdirSync,
	writeFileSync,
	existsSync,
	realpathSync,
} from "node:fs";
import path from "node:path";
import type { QueryEnvelope } from "./api-contracts";

export const TRIAGE_PROXY_TOKEN_HEADER = "x-birdclaw-triage-token";
export const TRIAGE_USER_HEADER = "x-birdclaw-triage-user";
export function isTeamTriage() {
	return process.env.BIRDCLAW_TEAM_TRIAGE === "1";
}
export function readTeamTriageConfig() {
	const origin = new URL(process.env.BIRDCLAW_TRIAGE_PUBLIC_ORIGIN ?? "");
	if (
		origin.protocol !== "https:" ||
		origin.origin !== origin.href.replace(/\/$/, "") ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash
	)
		throw new Error(
			"Team triage requires an exact separate HTTPS public origin",
		);
	const teamOrigin = new URL(process.env.BIRDCLAW_TRIAGE_TEAM_ORIGIN ?? "");
	if (
		teamOrigin.protocol !== "https:" ||
		teamOrigin.href.replace(/\/$/, "") !== teamOrigin.origin ||
		teamOrigin.hostname === origin.hostname
	)
		throw new Error(
			"Team triage requires a distinct exact HTTPS Team UI origin",
		);
	const file = process.env.BIRDCLAW_TRIAGE_PROXY_TOKEN_FILE;
	if (!file || !path.isAbsolute(file))
		throw new Error(
			"Team triage requires an absolute dedicated proxy-token file path",
		);
	const stat = lstatSync(file);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o077) !== 0 ||
		stat.size > 4096
	)
		throw new Error(
			"The dedicated proxy-token file must be a private regular file (0600)",
		);
	const token = readFileSync(file, "utf8").trim();
	if (!/^[A-Za-z0-9_-]{32,256}$/.test(token))
		throw new Error(
			"The dedicated proxy token must contain 32–256 URL-safe random characters",
		);
	return { origin: origin.origin, teamOrigin: teamOrigin.origin, token };
}
function constantEqual(left: string, right: string) {
	const a = Buffer.from(left),
		b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}
function denied(status: number, message: string) {
	return new Response(JSON.stringify({ message }), {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
	});
}
/** The proxy authenticates Team membership and overwrites both headers. Loopback is NOT authentication. */
export function teamTriageRequestErrorResponse(
	request: Request,
): Response | null {
	if (!isTeamTriage()) return null;
	let config: ReturnType<typeof readTeamTriageConfig>;
	try {
		config = readTeamTriageConfig();
	} catch {
		return denied(503, "Team triage proxy authentication is not configured");
	}
	const token = request.headers.get(TRIAGE_PROXY_TOKEN_HEADER) ?? "";
	const user = request.headers.get(TRIAGE_USER_HEADER) ?? "";
	if (
		!constantEqual(token, config.token) ||
		!/^[A-Za-z0-9][A-Za-z0-9@._:+-]{0,199}$/.test(user)
	)
		return denied(401, "Authenticated Team proxy access is required");
	const origin = request.headers.get("origin");
	if (
		(origin && origin !== config.origin) ||
		request.headers.get("sec-fetch-site") === "cross-site"
	)
		return denied(403, "Cross-origin Team triage access is disabled");
	if (
		request.method !== "GET" &&
		request.method !== "HEAD" &&
		origin !== config.origin
	)
		return denied(
			403,
			"The configured Team triage Origin is required for writes",
		);
	const url = new URL(request.url);
	const safeAsset =
		/^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|png|svg|woff2?|ico)$/.test(
			url.pathname,
		);
	const readPath =
		["/", "/shared-inbox", "/api/status"].includes(url.pathname) || safeAsset;
	if (
		(readPath && ["GET", "HEAD"].includes(request.method)) ||
		(url.pathname === "/api/shared-inbox" &&
			["GET", "HEAD", "POST"].includes(request.method))
	)
		return null;
	return denied(404, "This endpoint is unavailable in Team mentions-only mode");
}
export function teamTriageStatusEnvelope(): QueryEnvelope {
	return {
		teamTriage: true,
		readOnly: false,
		accounts: [],
		archives: [],
		transport: {
			installed: false,
			availableTransport: "local",
			statusText:
				"Team mentions-only service; see source coverage in Shared mentions",
		},
		stats: { home: 0, mentions: 0, dms: 0, needsReply: 0, inbox: 0 },
	};
}
export function teamTriageCapabilities() {
	return {
		settings: !isTeamTriage(),
		sync:
			!isTeamTriage() ||
			Boolean(process.env.BIRDCLAW_TRIAGE_SYNC_ACCOUNT?.trim()),
		handoff:
			!isTeamTriage() || process.env.BIRDCLAW_TRIAGE_ALLOW_HANDOFF === "1",
	};
}

const AUTH_MARKER = ".birdclaw-team-auth-purpose.json";
function authPurpose() {
	return {
		purpose: "birdclaw-team-xurl-only-v1",
		store: path.resolve(process.env.BIRDCLAW_HOME ?? ""),
	};
}
export function initializeTeamTriageAuthHome() {
	const root = process.env.BIRDCLAW_TRIAGE_AUTH_HOME;
	if (!root || !path.isAbsolute(root) || !process.env.BIRDCLAW_HOME)
		throw new Error(
			"Explicit dedicated authentication HOME and store paths are required",
		);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const stat = lstatSync(root);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o077) !== 0 ||
		realpathSync(root) !== path.resolve(root)
	)
		throw new Error(
			"The isolated authentication HOME must be a private real directory (0700)",
		);
	const marker = path.join(root, AUTH_MARKER);
	if (!existsSync(marker)) {
		if (readdirSync(root).length)
			throw new Error(
				"Refusing to adopt a nonempty authentication HOME; do not reuse a personal or shared X login",
			);
		writeFileSync(marker, JSON.stringify(authPurpose()) + "\n", {
			mode: 0o600,
			flag: "wx",
		});
	}
	assertAuthPurpose(root);
	return { ok: true, credentialsVerified: false };
}
function assertAuthPurpose(root: string) {
	const marker = path.join(root, AUTH_MARKER);
	const stat = lstatSync(marker);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o077) !== 0 ||
		stat.size > 4096
	)
		throw new Error("Authentication HOME has no private Team purpose marker");
	const stored = JSON.parse(readFileSync(marker, "utf8")) as {
		purpose?: string;
		store?: string;
	};
	const expected = authPurpose();
	if (stored.purpose !== expected.purpose || stored.store !== expected.store)
		throw new Error("Authentication HOME belongs to a different purpose/store");
}
export function assertTeamTriageAuthHome() {
	const root = process.env.BIRDCLAW_TRIAGE_AUTH_HOME;
	if (
		!root ||
		!path.isAbsolute(root) ||
		path.resolve(process.env.HOME ?? "") !== path.resolve(root) ||
		process.env.AUTH_TOKEN ||
		process.env.CT0
	)
		throw new Error(
			"Team triage requires HOME to be the explicit isolated authentication HOME, without inherited browser session cookies",
		);
	const stat = lstatSync(root);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o077) !== 0 ||
		realpathSync(root) !== path.resolve(root)
	)
		throw new Error(
			"The isolated service authentication HOME must be a private real directory (0700)",
		);
	assertAuthPurpose(root);
}
