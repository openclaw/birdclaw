// @vitest-environment node
import { startProductionServer } from "./production-server";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
	chmodSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { resetBirdclawPathsForTests } from "./config";
import {
	initializeTeamTriageStore,
	assertTeamTriageStore,
	configureTeamTriageAccount,
} from "./team-triage-store";
import {
	initializeTeamTriageAuthHome,
	teamTriageRequestErrorResponse,
	teamTriageStatusEnvelope,
	readTeamTriageConfig,
} from "./team-triage";
import { getSharedInbox, postSharedInbox } from "../routes/api/shared-inbox";
import { ingestTweetPayload } from "./tweet-repository";
import { readStatusBootstrap } from "./status-bootstrap.server";

const token = "synthetic_team_proxy_test_0123456789_abcdef";
let folder: string;
function request(
	route = "/api/shared-inbox",
	user = "user-a",
	body?: unknown,
	headers: Record<string, string> = {},
) {
	return new Request("http://127.0.0.1" + route, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			"x-birdclaw-triage-token": token,
			"x-birdclaw-triage-user": user,
			...(body === undefined
				? {}
				: {
						origin: "https://triage.example.test",
						"content-type": "application/json",
					}),
			...headers,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
beforeEach(() => {
	mkdirSync(".openclaw/tmp", { recursive: true });
	folder = mkdtempSync(
		path.join(process.cwd(), ".openclaw/tmp/team-triage-test-"),
	);
	mkdirSync(path.join(folder, "auth"), { mode: 0o700 });
	vi.stubEnv("BIRDCLAW_HOME", path.join(folder, "state"));
	vi.stubEnv("BIRDCLAW_TEST_SEED_DEMO_DATA", "0");
	vi.stubEnv("BIRDCLAW_CONFIG", "");
	vi.stubEnv("BIRDCLAW_ALLOW_REMOTE_WEB", "0");
	vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "0");
	vi.stubEnv("BIRDCLAW_TEAM_TRIAGE", "0");
	vi.stubEnv("AUTH_TOKEN", "");
	vi.stubEnv("CT0", "");
	resetBirdclawPathsForTests();
	initializeTeamTriageStore();
	configureTeamTriageAccount("triage_bot", "999");
	vi.stubEnv("BIRDCLAW_TEAM_TRIAGE", "1");
	vi.stubEnv("HOME", path.join(folder, "auth"));
	vi.stubEnv("BIRDCLAW_TRIAGE_AUTH_HOME", path.join(folder, "auth"));
	initializeTeamTriageAuthHome();
	vi.stubEnv("BIRDCLAW_TRIAGE_PUBLIC_ORIGIN", "https://triage.example.test");
	vi.stubEnv("BIRDCLAW_TRIAGE_TEAM_ORIGIN", "https://team.example.test");
	const file = path.join(folder, "proxy-token");
	writeFileSync(file, token, { mode: 0o600 });
	vi.stubEnv("BIRDCLAW_TRIAGE_PROXY_TOKEN_FILE", file);
	vi.stubEnv("BIRDCLAW_TRIAGE_ALLOW_HANDOFF", "0");
	vi.stubEnv("BIRDCLAW_TRIAGE_SYNC_ACCOUNT", "");
});
afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	vi.unstubAllEnvs();
	rmSync(folder, { recursive: true, force: true });
});
function addPublicTweet() {
	ingestTweetPayload(getNativeDb(), {
		accountId: "team-triage",
		source: "test",
		edgeKind: "search",
		payload: {
			data: [
				{
					id: "101",
					author_id: "777",
					text: "Synthetic fixture @openclaw @steipete public report",
					created_at: "2026-10-20T00:00:00Z",
				},
			],
			includes: {
				users: [
					{ id: "777", username: "test_report", name: "Synthetic report" },
				],
			},
		},
	});
}
describe("Team mentions-only authentication and storage", () => {
	it("requires proxy token AND canonical user even on loopback and in the test runtime", () => {
		for (const headers of [
			{},
			{ "x-birdclaw-triage-user": "spoof" },
			{ "x-birdclaw-triage-token": token },
			{ "x-birdclaw-token": token, "x-birdclaw-local-peer": "1" },
			{
				"x-birdclaw-triage-token": "wrong",
				"x-birdclaw-triage-user": "user-a",
			},
		])
			expect(
				teamTriageRequestErrorResponse(
					new Request("http://localhost/api/shared-inbox", {
						headers: headers as Record<string, string>,
					}),
				)?.status,
			).toBe(401);
		expect(teamTriageRequestErrorResponse(request())).toBeNull();
		expect(
			teamTriageRequestErrorResponse(request("/api/shared-inbox", "user-b")),
		).toBeNull();
	});
	it("rejects cross-origin/missing-Origin writes and malformed user assertions", () => {
		expect(
			teamTriageRequestErrorResponse(
				request(
					undefined,
					undefined,
					{ kind: "read" },
					{ origin: "https://evil.test" },
				),
			)?.status,
		).toBe(403);
		expect(
			teamTriageRequestErrorResponse(
				request(undefined, undefined, { kind: "read" }, { origin: "" }),
			)?.status,
		).toBe(403);
		expect(
			teamTriageRequestErrorResponse(
				request(undefined, undefined, undefined, {
					"sec-fetch-site": "cross-site",
				}),
			)?.status,
		).toBe(403);
		expect(
			teamTriageRequestErrorResponse(request(undefined, "bad user"))?.status,
		).toBe(401);
	});
	it("denies every archive/admin/live-write/MCP surface before a handler may run", () => {
		for (const route of [
			"/api/query?resource=dms",
			"/api/action",
			"/api/inbox",
			"/api/conversation",
			"/api/avatar?id=private",
			"/api/profile-hydrate",
			"/api/data-sources",
			"/api/sync",
			"/api/network-map",
			"/api/link-preview",
			"/mcp",
			"/MCP",
			"/dms",
			"/mentions",
			"/profiles/private",
			"/data-sources",
			"/assets/secret.sqlite",
			"/assets/%2e%2e/private.js",
		])
			expect(teamTriageRequestErrorResponse(request(route))?.status).toBe(404);
		expect(
			teamTriageRequestErrorResponse(request("/assets/app-HASH.js")),
		).toBeNull();
	});
	it("shares triage state between two users and keeps it through database close/reopen", async () => {
		addPublicTweet();
		expect((await getSharedInbox(request()).json()).items).toHaveLength(1);
		expect(
			(
				await postSharedInbox(
					request(undefined, "user-a", {
						kind: "read",
						ids: ["101"],
						value: true,
					}),
				)
			).status,
		).toBe(200);
		let view = await getSharedInbox(request(undefined, "user-b")).json();
		expect(view.items[0].readAt).toBeTruthy();
		expect(view.items[0].handledAt).toBeNull();
		await postSharedInbox(
			request(undefined, "user-b", { kind: "handled", id: "101", value: true }),
		);
		await postSharedInbox(
			request(undefined, "user-b", {
				kind: "classify",
				id: "101",
				value: "feature",
			}),
		);
		resetDatabaseForTests();
		view = await getSharedInbox(request(undefined, "user-a")).json();
		expect(view.items[0].handledAt).toBeTruthy();
		expect(view.items[0].readAt).toBeTruthy();
		expect(view.items[0].classification).toBe("feature");
		expect(view.teamTriage).toBe(true);
		expect(view.capabilities).toEqual({
			settings: false,
			sync: false,
			handoff: false,
		});
		expect(view.coverage.status).toBe("never");
		expect(view.coverage.lastSuccessAt).toBeNull();
	});
	it("prevents Team users from selecting accounts, changing names or dispatching unconfigured handoffs", async () => {
		for (const body of [
			{ kind: "settings", settings: { openclaw: ["Private"], peter: [] } },
			{ kind: "handoff", id: "101", classification: "bug" },
			{ kind: "sync", account: "personal" },
		])
			expect(
				(await postSharedInbox(request(undefined, "user-a", body))).status,
			).toBe(403);
	});
	it("returns no archive/account bootstrap data", async () => {
		const envelope = teamTriageStatusEnvelope();
		expect(envelope.accounts).toEqual([]);
		expect(envelope.archives).toEqual([]);
		expect(envelope.stats.dms).toBe(0);
		expect(
			(await readStatusBootstrap(request("/shared-inbox")))?.teamTriage,
		).toBe(true);
		expect(
			await readStatusBootstrap(new Request("http://localhost/shared-inbox")),
		).toBeNull();
	});
	it("rejects a personal full archive and refuses adopting an unmarked populated DB", () => {
		const db = getNativeDb();
		db.prepare(
			"delete from sync_cache where cache_key='shared-inbox:team-purpose:v1'",
		).run();
		addPublicTweet();
		expect(() => initializeTeamTriageStore()).toThrow(/existing populated/);
		expect(() => assertTeamTriageStore()).toThrow(
			/not an explicitly initialized/,
		);
	});
	it("refuses service startup after private DM data contaminates a marked store", () => {
		const db = getNativeDb();
		db.prepare(
			"insert into dm_conversations(id,account_id,participant_profile_id,title,last_message_at,unread_count,needs_reply) values ('private','team-triage','private-person','SECRET',?,0,0)",
		).run(new Date().toISOString());
		expect(() => assertTeamTriageStore()).toThrow(/private archive, DM/);
	});
	it("requires private proxy-token permissions and a distinct HTTPS app origin", () => {
		chmodSync(process.env.BIRDCLAW_TRIAGE_PROXY_TOKEN_FILE!, 0o644);
		expect(() => readTeamTriageConfig()).toThrow(/0600/);
		chmodSync(process.env.BIRDCLAW_TRIAGE_PROXY_TOKEN_FILE!, 0o600);
		vi.stubEnv("BIRDCLAW_TRIAGE_PUBLIC_ORIGIN", "https://team.example.test");
		expect(() => readTeamTriageConfig()).toThrow(/distinct/);
	});
	it("enforces authentication/allowlist on real loopback HTTP before SSR, static or MCP and refuses public binding", async () => {
		const fs = await import("node:fs");
		const entry = path.join(folder, "server-entry.mjs");
		fs.writeFileSync(
			entry,
			"export default {fetch(request) { return new Response('HANDLER_CANARY:' + new URL(request.url).pathname); }}",
		);
		mkdirSync(path.join(folder, "client/assets"), { recursive: true });
		fs.writeFileSync(
			path.join(folder, "client/assets/app.js"),
			"console.log('public-code')",
		);
		fs.writeFileSync(
			path.join(folder, "client/private.json"),
			"PRIVATE_ARCHIVE_CANARY",
		);
		await expect(
			startProductionServer({
				packageRoot: folder,
				serverEntry: entry,
				clientDir: path.join(folder, "client"),
				host: "0.0.0.0",
				port: 0,
			}),
		).rejects.toThrow("Team triage may bind only to loopback");
		const server = await startProductionServer({
			packageRoot: folder,
			serverEntry: entry,
			clientDir: path.join(folder, "client"),
			host: "127.0.0.1",
			port: 0,
		});
		try {
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("No address");
			const base = "http://127.0.0.1:" + address.port;
			for (const route of [
				"/shared-inbox",
				"/assets/app.js",
				"/api/shared-inbox",
				"/api/query",
				"/mcp",
			]) {
				const response = await fetch(base + route);
				expect(response.status).toBe(401);
				expect(await response.text()).not.toContain("CANARY");
			}
			const headers = {
				"x-birdclaw-triage-token": token,
				"x-birdclaw-triage-user": "user-b",
			};
			for (const route of [
				"/private.json",
				"/api/query?resource=dms",
				"/api/action",
				"/mcp",
				"/dms",
				"/assets/../private.json",
			]) {
				const response = await fetch(base + route, { headers });
				expect(response.status).toBe(404);
				expect(await response.text()).not.toContain("CANARY");
			}
			const asset = await fetch(base + "/assets/app.js", { headers });
			expect(asset.status).toBe(200);
			const page = await fetch(base + "/shared-inbox", { headers });
			expect(page.status).toBe(200);
			expect(page.headers.get("content-security-policy")).toContain(
				"https://team.example.test",
			);
			expect(page.headers.get("referrer-policy")).toBe("no-referrer");
			const redirect = await fetch(base + "/", { headers, redirect: "manual" });
			expect(redirect.status).toBe(302);
			expect(redirect.headers.get("location")).toBe("/shared-inbox");
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			});
		}
	});
	it("refuses to adopt an existing personal/shared authentication HOME", () => {
		const directory = path.join(folder, "unrelated-auth");
		mkdirSync(directory, { mode: 0o700 });
		writeFileSync(
			path.join(directory, "existing-login-marker"),
			"Synthetic existing state; no real credential",
		);
		vi.stubEnv("BIRDCLAW_TRIAGE_AUTH_HOME", directory);
		expect(() => initializeTeamTriageAuthHome()).toThrow(
			/Refusing to adopt a nonempty authentication HOME/,
		);
	});
});
