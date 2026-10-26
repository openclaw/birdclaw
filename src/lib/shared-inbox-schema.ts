import type { Database } from "./sqlite";
export function installSharedInbox(db: Database) {
	db.exec(
		"create table if not exists shared_inbox_settings (id integer primary key check(id = 1), settings_json text not null, updated_at text not null)",
	);
	db.exec(
		"create table if not exists shared_inbox_state (tweet_id text primary key, read_at text, handled_at text, classification text not null default 'unclassified' check(classification in ('unclassified', 'bug', 'feature')), updated_at text not null)",
	);
	db.exec(
		"create table if not exists shared_inbox_handoffs (tweet_id text primary key, idempotency_key text not null unique, payload_json text not null, classification text not null, status text not null check(status in ('pending','sending','accepted','failed','uncertain')), run_id text, error text, created_at text not null, updated_at text not null)",
	);
}
