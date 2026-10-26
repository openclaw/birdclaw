export const SHARED_INBOX_TARGETS = ["openclaw", "peter"] as const;
export type SharedInboxTarget = (typeof SHARED_INBOX_TARGETS)[number];
export type SharedInboxClassification = "unclassified" | "bug" | "feature";
export interface SharedInboxSettings {
	openclaw: string[];
	peter: string[];
}
export const DEFAULT_SHARED_INBOX_SETTINGS: SharedInboxSettings = {
	openclaw: ["OpenClaw", "Open Claw"],
	peter: ["Peter Steinberger", "steipete"],
};
export interface SharedInboxFilter {
	target?: "all" | SharedInboxTarget;
	read?: "all" | "unread" | "read";
	handled?: "all" | "open" | "handled";
	classification?: "all" | SharedInboxClassification;
	search?: string;
	offset?: number;
	limit?: number;
}
export interface SharedInboxHandoff {
	status: "pending" | "sending" | "accepted" | "failed" | "uncertain";
	classification: SharedInboxClassification;
	runId: string | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
}
export interface SharedInboxItem {
	id: string;
	text: string;
	authorHandle: string;
	authorName: string;
	createdAt: string;
	url: string | null;
	targets: SharedInboxTarget[];
	readAt: string | null;
	handledAt: string | null;
	classification: SharedInboxClassification;
	handoff: SharedInboxHandoff | null;
}
export interface SharedInboxResponse {
	teamTriage?: boolean;
	capabilities?: { settings: boolean; sync: boolean; handoff: boolean };
	coverage?: import("./shared-inbox-sync").SharedInboxCoverage;
	sourceReadiness?: {
		configured: boolean;
		executableAvailable: boolean;
		detail: string;
	};
	items: SharedInboxItem[];
	total: number;
	unread: number;
	open: number;
	offset: number;
	limit: number;
	settings: SharedInboxSettings;
	integration: { configured: boolean; detail: string };
}
export function safeSharedTweetUrl(id: string): string | null {
	return /^\d{1,30}$/.test(id) ? "https://x.com/i/status/" + id : null;
}
function escapePattern(value: string) {
	return Array.from(value, (character) =>
		"\\^$.*+?()[]{}|".includes(character) ? "\\" + character : character,
	).join("");
}
export function sharedInboxTargets(
	text: string,
	settings: SharedInboxSettings,
) {
	return SHARED_INBOX_TARGETS.filter((target) => {
		const handle = target === "peter" ? "steipete" : "openclaw";
		return ["@" + handle, ...settings[target]].some((term) =>
			new RegExp(
				"(?:^|[^\\p{L}\\p{N}_])" +
					escapePattern(term) +
					"(?=$|[^\\p{L}\\p{N}_])",
				"iu",
			).test(text),
		);
	});
}
export const MAX_UNREAD_OPEN_BATCH = 5;
/** Call synchronously in the click handler, before any awaited server write. */
export function openUnreadBatch(
	items: SharedInboxItem[],
	open: (url: string) => boolean,
	size = MAX_UNREAD_OPEN_BATCH,
) {
	const opened: string[] = [];
	const blocked: string[] = [];
	const ids = new Set<string>();
	const boundedSize = Math.min(
		MAX_UNREAD_OPEN_BATCH,
		Math.max(1, Math.floor(size) || 1),
	);
	for (const item of items) {
		if (item.readAt || ids.has(item.id)) continue;
		const url = safeSharedTweetUrl(item.id);
		if (!url) continue;
		ids.add(item.id);
		if (ids.size > boundedSize) break;
		if (open(url)) opened.push(item.id);
		else blocked.push(item.id);
	}
	return { opened, blocked };
}
