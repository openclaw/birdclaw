import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import Database from "./sqlite";
import { getNativeDb } from "./db";
import { writeSyncCache } from "./sync-cache";

const PURPOSE_KEY = "shared-inbox:team-purpose:v1";
const PURPOSE = "team-public-mentions-only-v1";
const PRIVATE_TABLES = [
	"dm_messages",
	"dm_conversations",
	"tweet_collections",
	"blocks",
	"mutes",
	"x_lists",
	"x_list_members",
	"follow_edges",
	"follow_snapshots",
	"tweet_actions",
	"ai_scores",
];
function storePaths(create = false) {
	const root = process.env.BIRDCLAW_HOME?.trim();
	if (
		!root ||
		!path.isAbsolute(root) ||
		process.env.BIRDCLAW_CONFIG ||
		process.env.BIRDCLAW_TEST_SEED_DEMO_DATA === "1" ||
		process.env.BIRDCLAW_DEPLOYMENT_READ_ONLY === "1" ||
		process.env.BIRDCLAW_ALLOW_REMOTE_WEB === "1"
	)
		throw new Error(
			"Team triage requires an explicit dedicated BIRDCLAW_HOME, no config override, demo seeding, read-only archive or remote-web bypass",
		);
	if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
	const stat = lstatSync(root);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o077) !== 0 ||
		realpathSync(root) !== path.resolve(root)
	)
		throw new Error(
			"The Team triage state root must be a private real directory (0700), without symlink ancestors",
		);
	const dbPath = path.join(root, "birdclaw.sqlite");
	if (
		existsSync(dbPath) &&
		(!lstatSync(dbPath).isFile() || lstatSync(dbPath).isSymbolicLink())
	)
		throw new Error("Team triage refuses a non-regular database path");
	return { root, dbPath };
}
function count(db: Database, table: string) {
	if (
		!db
			.prepare("select 1 from sqlite_master where type='table' and name=?")
			.get(table)
	)
		return 0;
	return Number(
		(db.prepare("select count(*) as n from " + table).get() as { n: number }).n,
	);
}
function purpose(db: Database) {
	if (
		!db
			.prepare(
				"select 1 from sqlite_master where type='table' and name='sync_cache'",
			)
			.get()
	)
		return false;
	const row = db
		.prepare("select value_json from sync_cache where cache_key=?")
		.get(PURPOSE_KEY) as { value_json: string } | undefined;
	if (!row) return false;
	try {
		return (
			(JSON.parse(row.value_json) as { purpose?: string }).purpose === PURPOSE
		);
	} catch {
		return false;
	}
}
function rejectPrivateData(db: Database) {
	if (PRIVATE_TABLES.some((table) => count(db, table) > 0))
		throw new Error(
			"Team triage refuses a database containing private archive, DM, saved, moderation or action data",
		);
}
/** Explicit operator initialization, never an archive import or automatic adoption of an existing populated store. */
export function initializeTeamTriageStore() {
	const { dbPath } = storePaths(true);
	if (existsSync(dbPath)) {
		const existing = new Database(dbPath, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			rejectPrivateData(existing);
			if (
				!purpose(existing) &&
				["tweets", "profiles", "accounts"].some(
					(table) => count(existing, table) > 0,
				)
			)
				throw new Error(
					"Refusing to adopt an existing populated store as Team mentions-only",
				);
		} finally {
			existing.close();
		}
	}
	const db = getNativeDb({ seedDemoData: false });
	writeSyncCache(
		PURPOSE_KEY,
		{ purpose: PURPOSE, createdAt: new Date().toISOString() },
		db,
	);
	return { ok: true, purpose: PURPOSE, empty: count(db, "tweets") === 0 };
}
/** Startup admission is read-only and happens before migrations, SSR, MCP or any listener. */
export function assertTeamTriageStore() {
	const { dbPath } = storePaths();
	if (!existsSync(dbPath))
		throw new Error(
			"Initialize a fresh Team mentions-only store before starting the service",
		);
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		if (!purpose(db))
			throw new Error(
				"This database is not an explicitly initialized Team mentions-only store",
			);
		rejectPrivateData(db);
	} finally {
		db.close();
	}
}
export function configureTeamTriageAccount(handle: string, userId: string) {
	assertTeamTriageStore();
	if (
		!/^[A-Za-z0-9_]{1,15}$/.test(handle.replace(/^@/, "")) ||
		!/^\d{1,30}$/.test(userId)
	)
		throw new Error(
			"An explicit X handle and numeric user ID are required; this does not establish a login",
		);
	const db = getNativeDb({ seedDemoData: false });
	db.prepare(
		"insert into accounts(id,name,handle,external_user_id,transport,is_default,created_at) values ('team-triage','Dedicated Team search',?,?,'xurl',1,?) on conflict(id) do update set handle=excluded.handle,external_user_id=excluded.external_user_id",
	).run(handle.replace(/^@/, ""), userId, new Date().toISOString());
	return { ok: true, accountId: "team-triage", credentialsVerified: false };
}

/** Grok uses an app key, not an X identity. This row is only local edge ownership. */
export function configureTeamGrokSource() {
	assertTeamTriageStore();
	const db = getNativeDb({ seedDemoData: false });
	db.prepare(
		"insert into accounts(id,name,handle,external_user_id,transport,is_default,created_at) values ('team-triage','Dedicated Grok search','birdclaw_grok_source',null,'grok',1,?) on conflict(id) do update set name=excluded.name,handle=excluded.handle,external_user_id=null,transport='grok'",
	).run(new Date().toISOString());
	return { ok: true, accountId: "team-triage", credentialsVerified: false };
}
