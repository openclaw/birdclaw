// @vitest-environment node
import { initializeTeamTriageAuthHome } from "./team-triage";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { resetBirdclawPathsForTests } from "./config";
import {
	initializeTeamTriageStore,
	configureTeamTriageAccount,
	configureTeamGrokSource,
} from "./team-triage-store";
import { writeSyncCache } from "./sync-cache";
const searchMock = vi.fn();
const identityMock = vi.fn();
const grokMock = vi.fn();
vi.mock("./grok-search", () => ({
	searchViaGrok: (...args: unknown[]) => grokMock(...args),
}));
vi.mock("./tweet-search-live", () => ({
	syncTweetSearchEffect: (...args: unknown[]) =>
		Effect.tryPromise(() => searchMock(...args)),
}));
vi.mock("./xurl", () => ({
	lookupPinnedOAuth2UserEffect: (...args: unknown[]) => identityMock(...args),
}));
import {
	readSharedInboxCoverage,
	recoverSharedInboxCoverage,
	syncSharedInbox,
	teamSourceReadiness,
	SharedInboxSyncBusyError,
} from "./shared-inbox-sync";
let folder: string;
beforeEach(() => {
	mkdirSync(".openclaw/tmp", { recursive: true });
	folder = mkdtempSync(
		path.join(process.cwd(), ".openclaw/tmp/team-source-test-"),
	);
	mkdirSync(path.join(folder, "bin"), { mode: 0o700 });
	writeFileSync(path.join(folder, "bin/xurl"), "#!/bin/sh\nexit 1\n", {
		mode: 0o700,
	});
	vi.stubEnv("BIRDCLAW_HOME", path.join(folder, "state"));
	vi.stubEnv("BIRDCLAW_TEST_SEED_DEMO_DATA", "0");
	vi.stubEnv("BIRDCLAW_CONFIG", "");
	vi.stubEnv("BIRDCLAW_ALLOW_REMOTE_WEB", "0");
	vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "0");
	resetBirdclawPathsForTests();
	initializeTeamTriageStore();
	configureTeamTriageAccount("triage_bot", "999");
	mkdirSync(path.join(folder, "auth"), { mode: 0o700 });
	vi.stubEnv("BIRDCLAW_TRIAGE_AUTH_HOME", path.join(folder, "auth"));
	vi.stubEnv("HOME", path.join(folder, "auth"));
	vi.stubEnv("AUTH_TOKEN", "");
	vi.stubEnv("CT0", "");
	initializeTeamTriageAuthHome();
	vi.stubEnv("BIRDCLAW_TEAM_TRIAGE", "1");
	vi.stubEnv("BIRDCLAW_TRIAGE_SYNC_ACCOUNT", "team-triage");
	vi.stubEnv("BIRDCLAW_XURL_OAUTH2_USERNAME", "triage_bot");
	vi.stubEnv("BIRDCLAW_XURL_OAUTH2_APP", "team-read-app");
	vi.stubEnv("PATH", path.join(folder, "bin"));
	searchMock.mockReset();
	grokMock.mockReset();
	vi.stubEnv("BIRDCLAW_TRIAGE_SOURCE", "xurl");
	identityMock.mockReset();
	identityMock.mockReturnValue(
		Effect.succeed({ username: "triage_bot", id: "999" }),
	);
});
afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	rmSync(folder, { recursive: true, force: true });
});
describe("source coverage is evidence, not row count", () => {
	it("does not call X while reading unverified setup and empty data", () => {
		expect(teamSourceReadiness().configured).toBe(true);
		expect(teamSourceReadiness().detail).toContain(
			"not proof of authentication",
		);
		expect(readSharedInboxCoverage().status).toBe("never");
		expect(readSharedInboxCoverage().lastSuccessAt).toBeNull();
		expect(identityMock).not.toHaveBeenCalled();
		expect(searchMock).not.toHaveBeenCalled();
	});
	it("pins live identity and six-day/100-result/two-page search, records a true zero-result sync and preserves it on reopen", async () => {
		searchMock.mockResolvedValue({
			ok: true,
			source: "xurl",
			accountId: "team-triage",
			query: "test",
			count: 0,
			pageCount: 1,
			tweetIds: [],
		});
		expect((await syncSharedInbox()).ok).toBe(true);
		expect(searchMock).toHaveBeenCalledWith(
			expect.objectContaining({
				account: "team-triage",
				mode: "xurl",
				limit: 100,
				maxPages: 2,
				refresh: true,
				since: expect.any(String),
			}),
		);
		const coverage = readSharedInboxCoverage();
		expect(coverage.status).toBe("succeeded");
		expect(coverage.fetched).toBe(0);
		expect(coverage.lastSuccessAt).toBeTruthy();
		expect(coverage.detail).toContain("not complete");
		resetDatabaseForTests();
		expect(readSharedInboxCoverage().lastSuccessAt).toBe(
			coverage.lastSuccessAt,
		);
		await expect(syncSharedInbox()).rejects.toBeInstanceOf(
			SharedInboxSyncBusyError,
		);
		expect(searchMock).toHaveBeenCalledTimes(1);
	});
	it("rejects a mismatched X account before search and redacts provider diagnostics", async () => {
		identityMock.mockReturnValue(
			Effect.succeed({ username: "someone_else", id: "111" }),
		);
		await expect(syncSharedInbox()).rejects.toThrow(
			"Live source verification or sync failed",
		);
		expect(searchMock).not.toHaveBeenCalled();
		expect(readSharedInboxCoverage().status).toBe("failed");
		expect(readSharedInboxCoverage().lastSuccessAt).toBeNull();
	});
	it("never treats cache-only reads as a verified live connection", async () => {
		searchMock.mockResolvedValue({
			ok: true,
			source: "cache",
			accountId: "team-triage",
			query: "test",
			count: 0,
			pageCount: 0,
			tweetIds: [],
		});
		await syncSharedInbox();
		expect(readSharedInboxCoverage().status).toBe("cached");
		expect(readSharedInboxCoverage().lastSuccessAt).toBeNull();
	});
	it("records redacted failures and interrupted source reads", async () => {
		identityMock.mockReturnValue(
			Effect.fail(new Error("secret-credential-diagnostic")),
		);
		await expect(syncSharedInbox()).rejects.toThrow(
			"Live source verification or sync failed",
		);
		expect(JSON.stringify(readSharedInboxCoverage())).not.toContain(
			"secret-credential",
		);
		writeSyncCache(
			"shared-inbox:source-coverage:v1",
			{ ...readSharedInboxCoverage(), status: "running" },
			getNativeDb(),
		);
		resetDatabaseForTests();
		recoverSharedInboxCoverage();
		expect(readSharedInboxCoverage().status).toBe("interrupted");
		expect(readSharedInboxCoverage().lastSuccessAt).toBeNull();
	});
	it("interrupts stalled identity work, records failure, releases overlap custody and permits a later retry", async () => {
		vi.useFakeTimers();
		let interrupted = false;
		identityMock.mockReturnValue(
			Effect.never.pipe(
				Effect.ensuring(
					Effect.sync(() => {
						interrupted = true;
					}),
				),
			),
		);
		const observed = syncSharedInbox().then(
			() => null,
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(20_100);
		const failure = await observed;
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe(
			"Live source verification or sync failed",
		);
		expect(interrupted).toBe(true);
		expect(readSharedInboxCoverage().status).toBe("failed");
		await vi.advanceTimersByTimeAsync(300_000);
		identityMock.mockReturnValue(
			Effect.succeed({ username: "triage_bot", id: "999" }),
		);
		searchMock.mockResolvedValue({
			ok: true,
			source: "xurl",
			accountId: "team-triage",
			query: "test",
			count: 0,
			pageCount: 1,
			tweetIds: [],
		});
		expect((await syncSharedInbox()).ok).toBe(true);
		expect(identityMock).toHaveBeenLastCalledWith(
			{ app: "team-read-app", username: "triage_bot" },
			{ timeoutMs: 20_000 },
		);
		expect(searchMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				pinnedOAuth2: { app: "team-read-app", username: "triage_bot" },
			}),
		);
	});
});

describe("Team Grok source selection", () => {
	it("ingests without X OAuth, preserves prior rows and shared state, and keeps cooldown", async () => {
		vi.stubEnv("BIRDCLAW_TRIAGE_SOURCE", "grok");
		vi.stubEnv("BIRDCLAW_XAI_API_KEY", "synthetic-test-key");
		vi.stubEnv("BIRDCLAW_XURL_OAUTH2_APP", "");
		configureTeamGrokSource();
		expect(
			getNativeDb()
				.prepare(
					"select external_user_id,transport from accounts where id='team-triage'",
				)
				.get(),
		).toMatchObject({ external_user_id: null, transport: "grok" });
		grokMock.mockResolvedValue({
			data: [
				{
					id: "123456789",
					author_id: "grok-handle:example",
					text: "OpenClaw issue",
					created_at: new Date().toISOString(),
				},
			],
			includes: {
				users: [
					{ id: "grok-handle:example", username: "example", name: "example" },
				],
			},
		});
		expect(teamSourceReadiness().configured).toBe(true);
		expect((await syncSharedInbox()).source).toBe("grok");
		expect(identityMock).not.toHaveBeenCalled();
		expect(searchMock).not.toHaveBeenCalled();
		const db = getNativeDb();
		db.prepare(
			"insert into shared_inbox_state(tweet_id,handled_at,classification,updated_at) values (?,?,'bug',?)",
		).run("123456789", "handled", "now");
		await expect(syncSharedInbox()).rejects.toBeInstanceOf(
			SharedInboxSyncBusyError,
		);
		writeSyncCache(
			"shared-inbox:source-coverage:v1",
			{ ...readSharedInboxCoverage(), lastAttemptAt: "2000-01-01T00:00:00Z" },
			db,
		);
		grokMock.mockResolvedValue({
			data: [
				{
					id: "123456789",
					author_id: "grok-handle:example",
					text: "changed",
					created_at: new Date().toISOString(),
				},
			],
		});
		await syncSharedInbox();
		expect(
			db.prepare("select text from tweets where id=?").get("123456789"),
		).toMatchObject({ text: "OpenClaw issue" });
		expect(
			db
				.prepare(
					"select handled_at,classification from shared_inbox_state where tweet_id=?",
				)
				.get("123456789"),
		).toMatchObject({ handled_at: "handled", classification: "bug" });
		expect(readSharedInboxCoverage().detail).toContain("Model extraction");
	});
	it("refuses client account overrides and missing key without fallback", async () => {
		vi.stubEnv("BIRDCLAW_TRIAGE_SOURCE", "grok");
		vi.stubEnv("BIRDCLAW_XAI_API_KEY", "");
		expect(teamSourceReadiness().configured).toBe(false);
		await expect(syncSharedInbox("personal")).rejects.toThrow(
			"Live source verification or sync failed",
		);
		expect(grokMock).not.toHaveBeenCalled();
		expect(identityMock).not.toHaveBeenCalled();
		expect(searchMock).not.toHaveBeenCalled();
	});
	it("redacts failed Grok calls and never verifies them", async () => {
		vi.stubEnv("BIRDCLAW_TRIAGE_SOURCE", "grok");
		vi.stubEnv("BIRDCLAW_XAI_API_KEY", "synthetic-test-key");
		grokMock.mockRejectedValue(new Error("synthetic-test-key"));
		await expect(syncSharedInbox()).rejects.toThrow(
			"Live source verification or sync failed",
		);
		expect(readSharedInboxCoverage().status).toBe("failed");
		expect(readSharedInboxCoverage().lastSuccessAt).toBeNull();
		expect(JSON.stringify(readSharedInboxCoverage())).not.toContain(
			"synthetic-test-key",
		);
	});
});
