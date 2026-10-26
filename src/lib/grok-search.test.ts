// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGrokSearch, searchViaGrok } from "./grok-search";
const since = "2026-10-15T00:00:00.000Z";
const until = "2026-10-22T00:00:00.000Z";
const id = String(
	(BigInt(Date.parse("2026-10-20T12:00:00Z")) - 1288834974657n) << 22n,
);
const url = `https://x.com/example/status/${id}`;
function fixture(
	posts: unknown[] = [{ url, text: "OpenClaw bug report" }],
	citations = [url],
) {
	return {
		status: "completed",
		output: [
			{ type: "custom_tool_call", name: "x_keyword_search" },
			{
				type: "message",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: JSON.stringify({ posts }),
						annotations: citations.map((url) => ({
							type: "url_citation",
							url,
						})),
					},
				],
			},
		],
	};
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
describe("Grok cited extraction boundary", () => {
	it("normalizes citation-backed posts and deduplicates without invented numeric identities", () => {
		const post = { url, text: "OpenClaw bug report" };
		const result = parseGrokSearch(fixture([post, post]), since, until);
		expect(result.data).toHaveLength(1);
		expect(result.data[0].created_at).toBe("2026-10-20T12:00:00.000Z");
		expect(result.data[0].author_id).toBe("grok-handle:example");
	});
	it("rejects uncited, off-host, out-of-window, malformed and incomplete extraction", () => {
		for (const body of [
			fixture(undefined, []),
			fixture([{ url: "https://evil.test/example/status/123", text: "bad" }]),
			fixture([{ url, text: "" }]),
			{ ...fixture(), status: "incomplete" },
		])
			expect(() => parseGrokSearch(body, since, until)).toThrow(Error);
		expect(() =>
			parseGrokSearch(fixture(), "2026-10-21T00:00:00Z", until),
		).toThrow(Error);
	});
	it("accepts provider-level i/status citations and rejects unexecuted search", () => {
		const body = {
			...fixture(undefined, []),
			citations: [`https://x.com/i/status/${id}`],
		};
		expect(parseGrokSearch(body, since, until).data).toHaveLength(1);
		expect(() =>
			parseGrokSearch(
				{ ...fixture([], []), output: fixture([], []).output.slice(1) },
				since,
				until,
			),
		).toThrow("No executed X search");
	});
	it("accepts an explicit empty completed search", () => {
		expect(parseGrokSearch(fixture([], []), since, until).data).toEqual([]);
	});
	it("pins the HTTPS consumer, refuses redirects, bounds turns and redacts errors", async () => {
		vi.stubEnv("BIRDCLAW_XAI_API_KEY", "synthetic-test-key");
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify(fixture())));
		vi.stubGlobal("fetch", fetchMock);
		expect((await searchViaGrok("OpenClaw", since, until)).data).toHaveLength(
			1,
		);
		const [endpoint, options] = fetchMock.mock.calls[0];
		expect(endpoint).toBe("https://api.x.ai/v1/responses");
		expect(options.redirect).toBe("error");
		expect(JSON.parse(options.body)).toMatchObject({
			store: false,
			max_turns: 2,
			tools: [
				{ type: "x_search", from_date: "2026-10-15", to_date: "2026-10-23" },
			],
		});
		fetchMock.mockRejectedValue(new Error("synthetic-test-key"));
		await expect(searchViaGrok("OpenClaw", since, until)).rejects.toThrow(
			"Grok search failed; check dedicated source configuration",
		);
	});
});
