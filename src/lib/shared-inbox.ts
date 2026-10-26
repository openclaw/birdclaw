import {
	readSharedInboxCoverage,
	teamSourceReadiness,
} from "./shared-inbox-sync";
import { isTeamTriage, teamTriageCapabilities } from "./team-triage";
import { roboclawHookConfiguration } from "./shared-inbox-hook-config";
import { z } from "zod";
import { getNativeDb, getReadDb } from "./db";
import { assertWritableDeployment } from "./config";
import type { Database } from "./sqlite";
import {
	DEFAULT_SHARED_INBOX_SETTINGS,
	SHARED_INBOX_TARGETS,
	sharedInboxTargets,
	safeSharedTweetUrl,
	type SharedInboxItem,
	type SharedInboxFilter,
	type SharedInboxSettings,
	type SharedInboxResponse,
	type SharedInboxHandoff,
} from "./shared-inbox-model";

const names = z
	.array(
		z
			.string()
			.trim()
			.min(2)
			.max(60)
			.regex(/^[\p{L}\p{N} ._-]+$/u),
	)
	.max(12);
export const sharedInboxSettingsSchema = z
	.object({ openclaw: names, peter: names })
	.strict();
export const sharedInboxFilterSchema = z.object({
	target: z.enum(["all", ...SHARED_INBOX_TARGETS]).default("all"),
	read: z.enum(["all", "unread", "read"]).default("all"),
	handled: z.enum(["all", "open", "handled"]).default("all"),
	classification: z
		.enum(["all", "unclassified", "bug", "feature"])
		.default("all"),
	search: z.string().max(300).default(""),
	offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
	limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const sharedInboxMutationSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("read"),
			ids: z.array(z.string().min(1).max(100)).min(1).max(100),
			value: z.boolean(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("handled"),
			id: z.string().min(1).max(100),
			value: z.boolean(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("classify"),
			id: z.string().min(1).max(100),
			value: z.enum(["unclassified", "bug", "feature"]),
		})
		.strict(),
	z
		.object({
			kind: z.literal("settings"),
			settings: sharedInboxSettingsSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("handoff"),
			id: z.string().min(1).max(100),
			classification: z.enum(["bug", "feature"]),
			context: z.string().trim().max(4000).default(""),
		})
		.strict(),
	z
		.object({
			kind: z.literal("sync"),
			account: z.string().max(100).optional(),
		})
		.strict(),
]);
export function getSharedInboxSettings(
	db: Database = getReadDb(),
): SharedInboxSettings {
	const row = db
		.prepare("select settings_json from shared_inbox_settings where id=1")
		.get() as { settings_json: string } | undefined;
	return row
		? sharedInboxSettingsSchema.parse(JSON.parse(row.settings_json))
		: structuredClone(DEFAULT_SHARED_INBOX_SETTINGS);
}
export function saveSharedInboxSettings(
	settings: SharedInboxSettings,
	db: Database = getNativeDb(),
) {
	assertWritableDeployment();
	const parsed = sharedInboxSettingsSchema.parse(settings);
	db.prepare(
		"insert into shared_inbox_settings values (1,?,?) on conflict(id) do update set settings_json=excluded.settings_json, updated_at=excluded.updated_at",
	).run(JSON.stringify(parsed), new Date().toISOString());
	return parsed;
}
export function getSharedInboxIntegration() {
	if (isTeamTriage() && !teamTriageCapabilities().handoff)
		return {
			configured: false,
			detail:
				"Roboclaw handoff is disabled for Team users until an operator explicitly authorizes and connects it.",
		};
	try {
		const configured = Boolean(roboclawHookConfiguration());
		return {
			configured,
			detail: configured
				? "OpenClaw agent hook configured; connectivity and work completion are not verified."
				: "Roboclaw is not connected. Sends are saved locally as pending, not delivered.",
		};
	} catch {
		return {
			configured: false,
			detail:
				"Roboclaw hook configuration is invalid. Sends stay local and pending until the operator fixes the connection.",
		};
	}
}
type TweetRow = {
	id: string;
	text: string;
	created_at: string;
	handle: string;
	display_name: string;
	read_at: string | null;
	handled_at: string | null;
	classification: SharedInboxItem["classification"];
};
export function getSharedInboxHandoff(
	id: string,
	db: Database = getReadDb(),
): SharedInboxHandoff | null {
	const row = db
		.prepare(
			"select status,classification,run_id as runId,error,created_at as createdAt,updated_at as updatedAt from shared_inbox_handoffs where tweet_id=?",
		)
		.get(id) as SharedInboxHandoff | undefined;
	return row ?? null;
}
function asItem(
	row: TweetRow,
	settings: SharedInboxSettings,
	db: Database,
): SharedInboxItem {
	return {
		id: row.id,
		text: row.text,
		authorHandle: row.handle,
		authorName: row.display_name,
		createdAt: row.created_at,
		url: safeSharedTweetUrl(row.id),
		targets: sharedInboxTargets(row.text, settings),
		readAt: row.read_at,
		handledAt: row.handled_at,
		classification: row.classification ?? "unclassified",
		handoff: getSharedInboxHandoff(row.id, db),
	};
}
const SELECT_TWEETS =
	"select t.id,t.text,t.created_at,p.handle,p.display_name,s.read_at,s.handled_at,s.classification from tweets t join profiles p on p.id=t.author_profile_id left join shared_inbox_state s on s.tweet_id=t.id ";
export function findSharedInboxItem(id: string, db: Database = getReadDb()) {
	const row = db
		.prepare(
			SELECT_TWEETS +
				"where t.id=? and t.deleted_at is null and t.superseded_at is null",
		)
		.get(id) as TweetRow | undefined;
	if (!row) throw new Error("Tweet is not available in the local store");
	const item = asItem(row, getSharedInboxSettings(db), db);
	if (!item.targets.length)
		throw new Error("Tweet does not match the shared inbox");
	return item;
}
export function listSharedInbox(
	filter: SharedInboxFilter = {},
	db: Database = getReadDb(),
): SharedInboxResponse {
	const query = sharedInboxFilterSchema.parse(filter);
	const settings = getSharedInboxSettings(db);
	// SQL preselection reduces allocations; exact literal token matching happens below.
	const terms = [
		"@openclaw",
		"@steipete",
		...settings.openclaw,
		...settings.peter,
	];
	const nonAscii = terms.some((term) => /[^\x00-\x7F]/.test(term));
	const predicates = terms
		.map(() => "instr(lower(t.text),lower(?)) > 0")
		.join(" or ");
	const rows = db
		.prepare(
			SELECT_TWEETS +
				"where t.deleted_at is null and t.superseded_at is null and (" +
				(nonAscii ? "1=1" : predicates) +
				") order by t.created_at desc,t.id desc",
		)
		.iterate(...(nonAscii ? [] : terms));
	let total = 0,
		unread = 0,
		open = 0;
	const items: SharedInboxItem[] = [];
	const search = query.search.toLocaleLowerCase();
	for (const value of rows) {
		const row = value as TweetRow;
		const targets = sharedInboxTargets(row.text, settings);
		if (
			!targets.length ||
			(query.target !== "all" && !targets.includes(query.target))
		)
			continue;
		if (
			search &&
			!(row.text + " " + row.handle + " " + row.display_name)
				.toLocaleLowerCase()
				.includes(search)
		)
			continue;
		if (
			query.classification !== "all" &&
			(row.classification ?? "unclassified") !== query.classification
		)
			continue;
		if (
			(query.handled === "open" && row.handled_at) ||
			(query.handled === "handled" && !row.handled_at)
		)
			continue;
		if (!row.read_at) unread++;
		if (!row.handled_at) open++;
		if (
			(query.read === "read" && !row.read_at) ||
			(query.read === "unread" && row.read_at)
		)
			continue;
		if (total >= query.offset && items.length < query.limit)
			items.push(asItem(row, settings, db));
		total++;
	}
	return {
		items,
		total,
		unread,
		open,
		offset: query.offset,
		limit: query.limit,
		settings,
		teamTriage: isTeamTriage(),
		capabilities: {
			...teamTriageCapabilities(),
			sync: !isTeamTriage() || teamSourceReadiness(db).configured,
		},
		coverage: readSharedInboxCoverage(db),
		sourceReadiness: teamSourceReadiness(db),
		integration: getSharedInboxIntegration(),
	};
}
export function updateSharedInboxState(
	input: Extract<
		z.infer<typeof sharedInboxMutationSchema>,
		{ kind: "read" | "handled" | "classify" }
	>,
	db: Database = getNativeDb(),
) {
	assertWritableDeployment();
	const ids = input.kind === "read" ? [...new Set(input.ids)] : [input.id];
	const column =
		input.kind === "read"
			? "read_at"
			: input.kind === "handled"
				? "handled_at"
				: "classification";
	const now = new Date().toISOString();
	const value =
		input.kind === "classify" ? input.value : input.value ? now : null;
	db.transaction(() => {
		for (const id of ids) {
			findSharedInboxItem(id, db);
			db.prepare(
				"insert into shared_inbox_state(tweet_id,updated_at) values (?,?) on conflict(tweet_id) do nothing",
			).run(id, now);
			db.prepare(
				"update shared_inbox_state set " +
					column +
					"=?,updated_at=? where tweet_id=?",
			).run(value, now, id);
		}
	})();
}
export function sharedInboxSearchQuery(settings: SharedInboxSettings) {
	const terms = [
		"@openclaw",
		"@steipete",
		...settings.openclaw,
		...settings.peter,
	];
	return (
		"(" +
		[...new Set(terms)]
			.map((term) => (term.startsWith("@") ? term : '"' + term + '"'))
			.join(" OR ") +
		")"
	);
}
