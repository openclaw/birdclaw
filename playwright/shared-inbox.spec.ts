import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { expect, test } from "@playwright/test";

const fixtureIds = [
	"900000000000000101",
	"900000000000000102",
	"900000000000000103",
];
test.beforeAll(() => {
	const db = new DatabaseSync(path.resolve(".playwright-home/birdclaw.sqlite"));
	db.exec("pragma busy_timeout=30000");
	db.prepare(
		"insert or ignore into profiles(id,handle,display_name,bio,created_at) values ('shared_demo_author','triage_demo','Demo fixture','Synthetic test content',?)",
	).run("2026-10-20T04:00:00Z");
	for (const [index, text] of [
		"Demo fixture — @openclaw @steipete: archive import crashes on this example.",
		"Demo fixture — Open Claw feature request: group related reports.",
		"Demo fixture — Peter Steinberger: a separate name-only mention.",
	].entries()) {
		db.prepare(
			"insert or replace into tweets(id,author_profile_id,text,created_at) values (?,'shared_demo_author',?,?)",
		).run(
			fixtureIds[index]!,
			text,
			"2026-10-20T0" + String(4 - index) + ":00:00Z",
		);
	}
	db.close();
});
test.beforeEach(async ({ context, baseURL }) => {
	await context.addCookies([
		{ name: "birdclaw_token", value: "birdclaw-e2e-token", url: baseURL! },
	]);
});
test("shared mentions persist triage, filter, explain blocked popups and record honest pending handoffs", async ({
	page,
	request,
}) => {
	await page.goto("/shared-inbox");
	await expect(
		page.getByRole("heading", { name: "Shared mentions", exact: true }),
	).toBeVisible();
	await page
		.getByRole("searchbox", { name: "Search shared mentions" })
		.fill("Demo fixture");
	await expect(page.locator(".shared-inbox-card")).toHaveCount(3);
	await expect(
		page
			.locator(".shared-inbox-card")
			.first()
			.getByRole("link", { name: "Open on X" }),
	).toHaveAttribute("href", "https://x.com/i/status/" + fixtureIds[0]);
	await expect(
		page
			.locator(".shared-inbox-card")
			.first()
			.getByRole("link", { name: "Open on X" }),
	).toHaveAttribute("rel", "noopener noreferrer");
	await page
		.locator(".shared-inbox-card")
		.first()
		.getByRole("button", { name: "Mark read", exact: true })
		.click();
	await expect(
		page
			.locator(".shared-inbox-card")
			.first()
			.getByRole("button", { name: "Mark unread", exact: true }),
	).toBeEnabled();
	await expect(
		page
			.locator(".shared-inbox-card")
			.first()
			.getByRole("button", { name: "Mark handled", exact: true }),
	).toBeEnabled();
	await page.reload();
	await page
		.getByRole("searchbox", { name: "Search shared mentions" })
		.fill("Demo fixture");
	await expect(
		page
			.locator(".shared-inbox-card")
			.first()
			.getByRole("button", { name: "Mark unread", exact: true }),
	).toBeEnabled();
	await page.getByRole("button", { name: "OpenClaw", exact: true }).click();
	await expect(page.locator(".shared-inbox-card")).toHaveCount(2);
	await page.getByLabel("Reading", { exact: true }).selectOption("unread");
	await expect(page.locator(".shared-inbox-card")).toHaveCount(1);
	await page.evaluate(() => {
		window.open = () => null;
	});
	await page
		.getByRole("button", { name: "Open unread (up to 5)", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText("0 opened · 1 blocked");
	await expect(
		page
			.locator(".shared-inbox-card")
			.getByRole("button", { name: "Mark read", exact: true }),
	).toBeEnabled();
	await page.getByLabel("Reading", { exact: true }).selectOption("all");
	await page.getByRole("button", { name: "All mentions", exact: true }).click();
	await page
		.locator(".shared-inbox-card")
		.first()
		.getByRole("button", { name: "Send to Roboclaw", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.getByLabel("Report type").selectOption("bug");
	await page
		.getByLabel("Context for Roboclaw")
		.fill("Synthetic reproduction, not live data.");
	await page
		.getByRole("button", { name: "Save pending handoff", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.locator(".shared-inbox-card").first()).toContainText(
		"Roboclaw · pending",
	);
	await page.reload();
	await page
		.getByRole("searchbox", { name: "Search shared mentions" })
		.fill("Demo fixture");
	await expect(page.locator(".shared-inbox-card").first()).toContainText(
		"Roboclaw · pending",
	);
	const response = await request.get(
		"/api/shared-inbox?search=Demo%20fixture",
		{ headers: { "x-birdclaw-token": "birdclaw-e2e-token" } },
	);
	expect(response.ok()).toBe(true);
	const body = await response.json();
	expect(body.items[0].handoff.status).toBe("pending");
	expect(body.items[0].handledAt).toBeNull();
	expect(body.items[0].readAt).toBeTruthy();
	await page.getByRole("button", { name: "Name matches", exact: true }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("successful batch opens sever openers and only confirmed tabs become read", async ({
	page,
	request,
}) => {
	const response = await request.post("/api/shared-inbox", {
		headers: { "x-birdclaw-token": "birdclaw-e2e-token" },
		data: { kind: "read", ids: fixtureIds, value: false },
	});
	expect(response.ok()).toBe(true);
	await page.goto("/shared-inbox");
	await page
		.getByRole("searchbox", { name: "Search shared mentions" })
		.fill("Demo fixture");
	await expect(page.locator(".shared-inbox-card")).toHaveCount(3);
	await page.evaluate(() => {
		const calls: Array<{ url: string; openerCleared: boolean }> = [];
		let attempts = 0;
		(window as unknown as { popupCalls: typeof calls }).popupCalls = calls;
		window.open = () => {
			attempts++;
			if (attempts === 2) return null;
			const popup = {
				opener: window as Window | null,
				document: {
					body: { append: () => {} },
					createElement: () => {
						const link = {
							href: "",
							target: "",
							rel: "",
							referrerPolicy: "",
							click: () =>
								calls.push({
									url: link.href,
									openerCleared: popup.opener === null,
								}),
						};
						return link;
					},
				},
			};
			return popup as unknown as Window;
		};
	});
	await page
		.getByRole("button", { name: "Open unread (up to 5)", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText("2 opened · 1 blocked");
	await expect(
		page
			.locator(".shared-inbox-card")
			.nth(0)
			.getByRole("button", { name: "Mark unread", exact: true }),
	).toBeEnabled();
	await expect(
		page
			.locator(".shared-inbox-card")
			.nth(1)
			.getByRole("button", { name: "Mark read", exact: true }),
	).toBeEnabled();
	await expect(
		page
			.locator(".shared-inbox-card")
			.nth(2)
			.getByRole("button", { name: "Mark unread", exact: true }),
	).toBeEnabled();
	expect(
		await page.evaluate(
			() =>
				(
					window as unknown as {
						popupCalls: Array<{ url: string; openerCleared: boolean }>;
					}
				).popupCalls,
		),
	).toEqual([
		{ url: "https://x.com/i/status/" + fixtureIds[0], openerCleared: true },
		{ url: "https://x.com/i/status/" + fixtureIds[2], openerCleared: true },
	]);
});

test("real batch popup has no opener or referrer without contacting X", async ({
	page,
	request,
	context,
}) => {
	await request.post("/api/shared-inbox", {
		headers: { "x-birdclaw-token": "birdclaw-e2e-token" },
		data: { kind: "read", ids: [fixtureIds[0]], value: false },
	});
	const referrers: Array<string | undefined> = [];
	await context.route("https://x.com/i/status/**", async (route) => {
		referrers.push(route.request().headers().referer);
		await route.fulfill({
			contentType: "text/html",
			body: "<title>Synthetic X destination</title><p>Browser safety test; no live X request.</p>",
		});
	});
	await page.goto("/shared-inbox");
	await page
		.getByRole("searchbox", { name: "Search shared mentions" })
		.fill("archive import crashes");
	await expect(page.locator(".shared-inbox-card")).toHaveCount(1);
	const popupPromise = page.waitForEvent("popup");
	await page
		.getByRole("button", { name: "Open unread (up to 5)", exact: true })
		.click();
	const popup = await popupPromise;
	await popup.waitForLoadState();
	expect(await popup.evaluate(() => window.opener === null)).toBe(true);
	expect(referrers).toEqual([undefined]);
	await expect(page.getByRole("status")).toContainText("1 opened · 0 blocked");
	await popup.close();
});
