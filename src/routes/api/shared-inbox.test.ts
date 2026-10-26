// @vitest-environment node
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { getNativeDb, resetDatabaseForTests } from "#/lib/db";
import { resetBirdclawPathsForTests } from "#/lib/config";
const syncMock = vi.fn();
vi.mock("#/lib/tweet-search-live", () => ({
	syncTweetSearchEffect: (...args: unknown[]) =>
		Effect.tryPromise(() => syncMock(...args)),
}));
import { getSharedInbox, postSharedInbox } from "./shared-inbox";
let folder: string;
beforeEach(() => {
	mkdirSync(".openclaw/tmp", { recursive: true });
	folder = mkdtempSync(
		path.join(process.cwd(), ".openclaw/tmp/shared-api-test-"),
	);
	vi.stubEnv("BIRDCLAW_HOME", folder);
	vi.stubEnv("BIRDCLAW_TEST_SEED_DEMO_DATA", "0");
	resetBirdclawPathsForTests();
	getNativeDb({ seedDemoData: false });
	syncMock.mockReset();
});
afterEach(() => {
	resetDatabaseForTests();
	resetBirdclawPathsForTests();
	vi.unstubAllEnvs();
	rmSync(folder, { recursive: true, force: true });
});
const post = (value: unknown, headers: Record<string, string> = {}) =>
	new Request("http://localhost/api/shared-inbox", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(value),
	});
describe("shared inbox authenticated API", () => {
	it("serves local results without live calls and uses no-store", async () => {
		const response = getSharedInbox(
			new Request("http://localhost/api/shared-inbox"),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect((await response.json()).items).toEqual([]);
		expect(syncMock).not.toHaveBeenCalled();
	});
	it("validates filters, actions and name matches", async () => {
		expect(
			getSharedInbox(
				new Request("http://localhost/api/shared-inbox?limit=10000"),
			).status,
		).toBe(400);
		expect(
			(await postSharedInbox(post({ kind: "read", ids: [], value: true })))
				.status,
		).toBe(400);
		expect(
			(
				await postSharedInbox(
					post({
						kind: "settings",
						settings: { openclaw: ['bad" OR'], peter: [] },
					}),
				)
			).status,
		).toBe(400);
		expect(
			(
				await postSharedInbox(
					post({
						kind: "settings",
						settings: { openclaw: ["Open Claw"], peter: ["Peter Steinberger"] },
					}),
				)
			).status,
		).toBe(200);
		expect(
			(
				await getSharedInbox(
					new Request("http://localhost/api/shared-inbox"),
				).json()
			).settings.openclaw,
		).toEqual(["Open Claw"]);
	});
	it("blocks unauthorized remote, cross-origin and read-only mutations", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("VITEST", "false");
		vi.stubEnv("BIRDCLAW_LOCAL_WEB", "1");
		vi.stubEnv("BIRDCLAW_WEB_TOKEN", "secret");
		vi.stubEnv("BIRDCLAW_ALLOW_REMOTE_WEB", "1");
		expect(
			getSharedInbox(new Request("https://private.example/api/shared-inbox"))
				.status,
		).toBe(403);
		expect(
			getSharedInbox(
				new Request("https://private.example/api/shared-inbox", {
					headers: {
						"x-birdclaw-token": "secret",
						origin: "https://evil.example",
					},
				}),
			).status,
		).toBe(403);
		expect(
			getSharedInbox(
				new Request("https://private.example/api/shared-inbox", {
					headers: { "x-birdclaw-token": "secret" },
				}),
			).status,
		).toBe(200);
		vi.stubEnv("BIRDCLAW_DEPLOYMENT_READ_ONLY", "1");
		expect((await postSharedInbox(post({ kind: "sync" }))).status).toBe(405);
		expect(syncMock).not.toHaveBeenCalled();
	});
	it("reuses bounded live search and redacts transport failures", async () => {
		syncMock.mockResolvedValue({ ok: true, count: 8, source: "bird" });
		const response = await postSharedInbox(post({ kind: "sync" }));
		expect(response.status).toBe(200);
		expect(syncMock).toHaveBeenCalledWith(
			expect.objectContaining({
				limit: 100,
				maxPages: 2,
				mode: "auto",
				refresh: true,
			}),
		);
		syncMock.mockResolvedValue({ ok: false, error: "credential=secret" });
		const failed = await postSharedInbox(post({ kind: "sync" }));
		expect(failed.status).toBe(502);
		expect(await failed.text()).not.toContain("credential=secret");
	});
	it("prevents overlapping sync and does not fake success on failure", async () => {
		let resolve: (value: unknown) => void = () => {};
		syncMock.mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const first = postSharedInbox(post({ kind: "sync" }));
		await new Promise((done) => setTimeout(done, 0));
		expect((await postSharedInbox(post({ kind: "sync" }))).status).toBe(409);
		resolve({ ok: true, count: 0, source: "cache" });
		expect((await first).status).toBe(200);
	});
});
