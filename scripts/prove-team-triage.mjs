import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, expect } from "@playwright/test";

const root = process.cwd();
if (
	!existsSync(path.join(root, "dist/server/server.js")) ||
	!existsSync(path.join(root, "dist/cli/birdclaw.js"))
)
	throw new Error(
		"Build the current candidate before running Team deployment proof",
	);
mkdirSync(path.join(root, ".openclaw/tmp"), { recursive: true });
const artifactDir = mkdtempSync(
	path.join(root, ".openclaw/tmp/team-triage-proof-"),
);
const state = path.join(artifactDir, "state"),
	auth = path.join(artifactDir, "auth");
mkdirSync(auth, { mode: 0o700 });
const secret = randomBytes(32).toString("base64url");
const tokenFile = path.join(artifactDir, "proxy-token");
writeFileSync(tokenFile, secret, { mode: 0o600 });
const origin = "https://birdclaw-security-fixture.example.test";
const env = {
	...process.env,
	HOME: auth,
	BIRDCLAW_HOME: state,
	BIRDCLAW_CONFIG: "",
	BIRDCLAW_TEST_SEED_DEMO_DATA: "0",
	BIRDCLAW_ALLOW_REMOTE_WEB: "0",
	BIRDCLAW_DEPLOYMENT_READ_ONLY: "0",
	BIRDCLAW_TEAM_TRIAGE: "1",
	BIRDCLAW_TRIAGE_PUBLIC_ORIGIN: origin,
	BIRDCLAW_TRIAGE_TEAM_ORIGIN: "https://team.example.test",
	BIRDCLAW_TRIAGE_AUTH_HOME: auth,
	BIRDCLAW_TRIAGE_PROXY_TOKEN_FILE: tokenFile,
	BIRDCLAW_TRIAGE_SYNC_ACCOUNT: "",
	BIRDCLAW_TRIAGE_ALLOW_HANDOFF: "0",
	BIRDCLAW_ROBOCLAW_HOOK_URL: "",
	BIRDCLAW_ROBOCLAW_HOOK_TOKEN: "",
	BIRDCLAW_BACKUP_AUTO_SYNC: "0",
	BIRDCLAW_DISABLE_LIVE_WRITES: "1",
	BIRDCLAW_DISABLE_LIVE_PROFILE_LOOKUP: "1",
	AUTH_TOKEN: "",
	CT0: "",
};
const cli = path.join(root, "bin/birdclaw.mjs");
const init = spawnSync(
	process.execPath,
	[cli, "--json", "shared-inbox", "init-team"],
	{ cwd: root, env, encoding: "utf8" },
);
if (init.status !== 0)
	throw new Error("Dedicated store initialization failed: " + init.stderr);
const authInit = spawnSync(
	process.execPath,
	[cli, "--json", "shared-inbox", "init-team-auth-home"],
	{ cwd: root, env, encoding: "utf8" },
);
if (authInit.status !== 0)
	throw new Error(
		"Dedicated authentication HOME initialization failed: " + authInit.stderr,
	);
let child, backend, browser;
const pids = [];
const proxyHeaders = (user) => ({
	"x-birdclaw-triage-token": secret,
	"x-birdclaw-triage-user": user,
});
async function start() {
	child = spawn(
		process.execPath,
		[cli, "--json", "serve", "--host", "127.0.0.1", "--port", "0"],
		{ cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	pids.push(child.pid);
	let buffer = "",
		diagnostics = "";
	child.stderr.on("data", (chunk) => {
		diagnostics += String(chunk).slice(0, 2000);
	});
	backend = await new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Owned service readiness timed out")),
			15000,
		);
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(
				new Error(
					"Owned service exited before ready: " + code + " " + diagnostics,
				),
			);
		});
		child.stdout.on("data", (chunk) => {
			buffer += String(chunk);
			for (const line of buffer.split("\n")) {
				try {
					const value = JSON.parse(line);
					if (value.ok && value.url) {
						clearTimeout(timer);
						resolve(value.url);
					}
				} catch {
					/* wait for JSON listening receipt */
				}
			}
		});
	});
}
async function stop() {
	if (!child || child.exitCode !== null || child.signalCode !== null) {
		child = null;
		return;
	}
	const process = child;
	await new Promise((resolve) => {
		process.once("exit", resolve);
		process.kill("SIGTERM");
	});
	child = null;
}
try {
	await start();
	for (const route of [
		"/shared-inbox",
		"/api/shared-inbox",
		"/api/status",
		"/assets/unknown.js",
		"/mcp",
	]) {
		const response = await fetch(backend + route);
		if (response.status !== 401)
			throw new Error("Unauthenticated boundary failed: " + route);
	}
	for (const route of [
		"/api/query?resource=dms",
		"/api/action",
		"/api/inbox",
		"/api/conversation",
		"/api/avatar?id=private",
		"/api/profile-hydrate",
		"/api/sync",
		"/dms",
		"/data-sources",
		"/mcp",
	]) {
		const response = await fetch(backend + route, {
			headers: proxyHeaders("fixture-a"),
		});
		if (response.status !== 404)
			throw new Error("Archive boundary failed: " + route);
	}
	const status = await (
		await fetch(backend + "/api/status", { headers: proxyHeaders("fixture-a") })
	).json();
	if (!status.teamTriage || status.accounts.length || status.archives.length)
		throw new Error("Status leaked archive/account metadata");
	browser = await chromium.launch({ headless: true });
	async function context(user) {
		const context = await browser.newContext({
			viewport: { width: 1440, height: 1080 },
			colorScheme: "light",
		});
		await context.route(origin + "/**", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const headers = { ...request.headers(), ...proxyHeaders(user) };
			delete headers.host;
			const response = await route.fetch({
				url: backend + url.pathname + url.search,
				headers,
				maxRedirects: 0,
			});
			await route.fulfill({ response });
		});
		return context;
	}
	const contextA = await context("fixture-a"),
		contextB = await context("fixture-b");
	const a = await contextA.newPage(),
		b = await contextB.newPage();
	const errors = [];
	a.on("pageerror", (error) => errors.push(error.message));
	b.on("pageerror", (error) => errors.push(error.message));
	await a.goto(origin + "/shared-inbox");
	await expect(
		a.getByRole("heading", { name: "Shared mentions", exact: true }),
	).toBeVisible();
	await expect(
		a.getByRole("heading", { name: "No matching mentions", exact: true }),
	).toBeVisible();
	await expect(
		a.getByText("No live sync has been verified.", { exact: false }),
	).toBeVisible();
	await expect(a.getByRole("link", { name: "DMs", exact: true })).toHaveCount(
		0,
	);
	await expect(
		a.getByRole("button", { name: "Name matches", exact: true }),
	).toHaveCount(0);
	await expect(
		a.getByRole("button", { name: "Sync mentions", exact: true }),
	).toBeDisabled();
	await a.screenshot({
		path: path.join(artifactDir, "team-empty.png"),
		animations: "disabled",
	});
	const db = new DatabaseSync(path.join(state, "birdclaw.sqlite"));
	db.exec("pragma busy_timeout=30000");
	db.prepare(
		"insert into profiles(id,handle,display_name,bio,created_at) values ('fixture','security_fixture','Synthetic security fixture','Not live X data',?)",
	).run(new Date().toISOString());
	db.prepare(
		"insert into tweets(id,author_profile_id,text,created_at) values ('900000000000000101','fixture',?,?)",
	).run(
		"Synthetic security fixture — @openclaw @steipete: example report for two-user persistence testing. This is not live X data.",
		new Date().toISOString(),
	);
	db.close();
	await a.reload();
	await expect(a.locator(".shared-inbox-card")).toHaveCount(1);
	await a.getByRole("button", { name: "Mark read", exact: true }).click();
	await expect(
		a.getByRole("button", { name: "Mark unread", exact: true }),
	).toBeEnabled();
	await b.goto(origin + "/shared-inbox");
	await expect(
		b.getByRole("button", { name: "Mark unread", exact: true }),
	).toBeEnabled();
	await b.getByRole("button", { name: "Mark handled", exact: true }).click();
	await expect(
		b.getByRole("button", { name: "Reopen", exact: true }),
	).toBeEnabled();
	await b
		.getByLabel("Classify tweet 900000000000000101")
		.selectOption("feature");
	await expect(
		b.getByText("Feature request", { exact: true }).first(),
	).toBeVisible();
	await stop();
	await start();
	await a.reload();
	await expect(
		a.getByRole("button", { name: "Mark unread", exact: true }),
	).toBeEnabled();
	await expect(
		a.getByRole("button", { name: "Reopen", exact: true }),
	).toBeEnabled();
	await expect(a.getByLabel("Classify tweet 900000000000000101")).toHaveValue(
		"feature",
	);
	await a.screenshot({
		path: path.join(artifactDir, "team-shared-state.png"),
		animations: "disabled",
	});
	await a.setViewportSize({ width: 390, height: 844 });
	await a.screenshot({
		path: path.join(artifactDir, "team-mobile.png"),
		animations: "disabled",
		fullPage: true,
	});
	const overflow = await a.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth,
	);
	if (overflow) throw new Error("Mobile overflow");
	const view = await (
		await fetch(backend + "/api/shared-inbox", {
			headers: proxyHeaders("fixture-b"),
		})
	).json();
	if (
		!view.items[0].readAt ||
		!view.items[0].handledAt ||
		view.items[0].classification !== "feature" ||
		view.coverage.status !== "never" ||
		view.coverage.lastSuccessAt !== null
	)
		throw new Error("Restart shared-state/coverage assertion failed");
	if (errors.length) throw new Error("UI page errors: " + errors.join(";"));
	const report = {
		artifactDir,
		source: "current built candidate",
		pids,
		restartWasNewProcess: pids[0] !== pids[1],
		twoUserSharedState: true,
		unauthenticatedRejected: true,
		archiveEndpointsDenied: true,
		minimalStatus: true,
		mobileOverflow: false,
		pageErrors: errors,
		coverage: "never verified; no live data",
		teamSsoVerified: false,
		liveXVerified: false,
		dashboardDelivered: false,
		proxy:
			"Synthetic authenticated-header fixture; real operator Team-membership edge remains unverified",
	};
	writeFileSync(
		path.join(artifactDir, "report.json"),
		JSON.stringify(report, null, 2) + "\n",
	);
	console.log(JSON.stringify(report));
} finally {
	if (browser) await browser.close();
	await stop();
}
