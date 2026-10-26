import { useDeploymentMode } from "#/lib/deployment-mode";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryAccount } from "#/components/account-selection";
import { fetchQueryEnvelope } from "#/lib/api-client";
import { queryKeys } from "#/lib/query-client";
import {
	ArrowUpRight,
	Check,
	Circle,
	Inbox,
	RefreshCw,
	Send,
	Settings2,
} from "lucide-react";
import {
	openUnreadBatch,
	type SharedInboxResponse,
	type SharedInboxItem,
	type SharedInboxFilter,
	type SharedInboxSettings,
} from "#/lib/shared-inbox-model";
import {
	primaryButtonClass,
	secondaryButtonClass,
	textFieldClass,
} from "#/lib/ui";
import { responseError } from "#/lib/client-http";

export const Route = createFileRoute("/shared-inbox")({
	component: SharedInboxView,
});
async function requestInbox(
	filter: SharedInboxFilter,
	signal: AbortSignal,
): Promise<SharedInboxResponse> {
	const params = new URLSearchParams(
		Object.entries(filter).map(([key, value]) => [key, String(value)]),
	);
	const response = await fetch("/api/shared-inbox?" + params, {
		signal,
		cache: "no-store",
	});
	if (!response.ok)
		throw await responseError(response, {
			label: "Shared mentions unavailable",
		});
	return response.json() as Promise<SharedInboxResponse>;
}
export function SharedInboxView() {
	const { teamTriage } = useDeploymentMode();
	const statusQuery = useQuery({
		queryKey: queryKeys.status,
		queryFn: ({ signal }) => fetchQueryEnvelope({ signal }),
	});
	const { selectedAccountId } = useQueryAccount(statusQuery);
	const [filter, setFilter] = useState<SharedInboxFilter>({
		target: "all",
		read: "all",
		handled: "all",
		classification: "all",
		search: "",
		offset: 0,
		limit: 30,
	});
	const [busy, setBusy] = useState(false);
	const actionLock = useRef(false);
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	const [settings, setSettings] = useState<SharedInboxSettings | null>(null);
	const [handoff, setHandoff] = useState<SharedInboxItem | null>(null);
	const [classification, setClassification] = useState<"bug" | "feature">(
		"bug",
	);
	const [context, setContext] = useState("");
	const query = useQuery({
		queryKey: ["shared-inbox", filter],
		queryFn: ({ signal }) => requestInbox(filter, signal),
		staleTime: 0,
		refetchInterval: teamTriage ? 15_000 : false,
		refetchIntervalInBackground: false,
	});
	const data = query.data;
	const items = data?.items ?? [];
	const capabilities = data?.capabilities ?? {
		sync: !teamTriage,
		settings: !teamTriage,
		handoff: !teamTriage,
	};
	function changeFilter(next: Partial<SharedInboxFilter>) {
		setFilter((previous) => ({ ...previous, ...next, offset: 0 }));
	}
	async function mutate(input: unknown, success: string) {
		if (actionLock.current) return false;
		actionLock.current = true;
		setBusy(true);
		setError("");
		try {
			const response = await fetch("/api/shared-inbox", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
			});
			if (!response.ok)
				throw await responseError(response, { label: "Action failed" });
			setNotice(success);
			await query.refetch();
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Action failed");
			return false;
		} finally {
			actionLock.current = false;
			setBusy(false);
		}
	}
	function openBatch() {
		if (actionLock.current) return;
		const result = openUnreadBatch(items, (url) => {
			try {
				const popup = window.open("about:blank", "_blank");
				if (!popup) return false;
				popup.opener = null;
				const link = popup.document.createElement("a");
				link.href = url;
				link.target = "_self";
				link.rel = "noopener noreferrer";
				link.referrerPolicy = "no-referrer";
				popup.document.body.append(link);
				link.click();
				return true;
			} catch {
				return false;
			}
		});
		const message =
			String(result.opened.length) +
			" opened · " +
			String(result.blocked.length) +
			" blocked. Blocked tweets stay unread; allow popups or use Open on X.";
		setNotice(message);
		if (result.opened.length)
			void mutate(
				{ kind: "read", ids: result.opened, value: true },
				message + " Opened tweets marked read, not handled.",
			);
	}
	async function submitHandoff(event: React.SubmitEvent) {
		event.preventDefault();
		if (!handoff) return;
		if (
			await mutate(
				{ kind: "handoff", id: handoff.id, classification, context },
				"Handoff recorded. See its delivery status on the tweet; this does not mark it handled.",
			)
		)
			setHandoff(null);
	}
	return (
		<section className="shared-inbox" aria-label="Shared mentions workspace">
			<header className="shared-inbox-header">
				<div className="shared-inbox-eyebrow">
					<Inbox size={15} /> TEAM TRIAGE · LOCAL FIRST
				</div>
				<h1>Shared mentions</h1>
				<p>One inbox for OpenClaw and Peter. Read is not resolved.</p>
				<div className="shared-inbox-stats">
					<span>
						<strong>{data?.total ?? "—"}</strong> matching
					</span>
					<span>
						<strong>{data?.unread ?? "—"}</strong> unread
					</span>
					<span>
						<strong>{data?.open ?? "—"}</strong> not handled
					</span>
				</div>
				<div className="shared-inbox-toolbar">
					<button
						className={primaryButtonClass}
						disabled={busy || !items.some((item) => !item.readAt && item.url)}
						onClick={openBatch}
					>
						<ArrowUpRight size={16} /> Open unread (up to 5)
					</button>
					<button
						className={secondaryButtonClass}
						disabled={busy || !capabilities.sync}
						onClick={() =>
							void mutate(
								{
									kind: "sync",
									...(!teamTriage && selectedAccountId
										? { account: selectedAccountId }
										: {}),
								},
								"Bounded live search completed. Local results refreshed.",
							)
						}
					>
						<RefreshCw size={15} /> Sync mentions
					</button>
					{capabilities.settings && (
						<button
							className={secondaryButtonClass}
							disabled={!data || busy}
							onClick={() => setSettings(structuredClone(data!.settings))}
						>
							<Settings2 size={15} /> Name matches
						</button>
					)}
				</div>
				<p className="shared-inbox-help">
					Opens unread tweets on this page only. Only confirmed popup opens are
					marked read.
				</p>
			</header>
			{data?.coverage && (
				<section
					className="shared-inbox-coverage"
					aria-label="Live source coverage"
				>
					<strong>
						{teamTriage ? "Team-shared mentions-only state" : "Source coverage"}{" "}
						· {data.coverage.status}
					</strong>
					<p>{data.sourceReadiness?.detail}</p>
					<p>{data.coverage.detail}</p>
					<p>
						Last attempt:{" "}
						{data.coverage.lastAttemptAt
							? new Date(data.coverage.lastAttemptAt).toLocaleString()
							: "never"}{" "}
						· Last verified live sync:{" "}
						{data.coverage.lastSuccessAt
							? new Date(data.coverage.lastSuccessAt).toLocaleString()
							: "never"}
					</p>
					{data.coverage.searchedSince && (
						<p>
							Bounded recent window since{" "}
							{new Date(data.coverage.searchedSince).toLocaleString()}; at most
							100 results / two pages. Last fetched:{" "}
							{data.coverage.fetched ?? "unknown"}.
						</p>
					)}
					<button
						className={secondaryButtonClass}
						disabled={query.isFetching}
						onClick={() => void query.refetch()}
					>
						Refresh shared state
					</button>
				</section>
			)}

			<div className="shared-inbox-filters">
				<div className="shared-inbox-targets" aria-label="Mention target">
					{(
						[
							["all", "All mentions"],
							["openclaw", "OpenClaw"],
							["peter", "Peter"],
						] as const
					).map(([value, label]) => (
						<button
							key={value}
							aria-pressed={filter.target === value}
							onClick={() => changeFilter({ target: value })}
						>
							{label}
						</button>
					))}
				</div>
				<label className="shared-inbox-search">
					<span className="sr-only">Search shared mentions</span>
					<input
						className={textFieldClass}
						type="search"
						placeholder="Search tweets or authors"
						value={filter.search}
						onChange={(event) => changeFilter({ search: event.target.value })}
					/>
				</label>
				<div className="shared-inbox-selects">
					<label>
						Reading
						<select
							aria-label="Reading"
							value={filter.read}
							onChange={(event) =>
								changeFilter({
									read: event.target.value as SharedInboxFilter["read"],
								})
							}
						>
							<option value="all">All reading states</option>
							<option value="unread">Unread</option>
							<option value="read">Read</option>
						</select>
					</label>
					<label>
						Resolution
						<select
							aria-label="Resolution"
							value={filter.handled}
							onChange={(event) =>
								changeFilter({
									handled: event.target.value as SharedInboxFilter["handled"],
								})
							}
						>
							<option value="all">All resolutions</option>
							<option value="open">Not handled</option>
							<option value="handled">Handled</option>
						</select>
					</label>
					<label>
						Classification
						<select
							aria-label="Classification"
							value={filter.classification}
							onChange={(event) =>
								changeFilter({
									classification: event.target
										.value as SharedInboxFilter["classification"],
								})
							}
						>
							<option value="all">All types</option>
							<option value="unclassified">Unclassified</option>
							<option value="bug">Bug reports</option>
							<option value="feature">Feature requests</option>
						</select>
					</label>
				</div>
			</div>
			{data && (
				<div className="shared-inbox-integration">
					<span
						className={
							data.integration.configured
								? "shared-inbox-dot connected"
								: "shared-inbox-dot"
						}
					/>
					{data.integration.detail}
				</div>
			)}
			{notice && (
				<div role="status" className="shared-inbox-notice">
					{notice}
				</div>
			)}
			{(error || query.error) && (
				<div role="alert" className="shared-inbox-error">
					{error || query.error?.message}
					<button
						className={secondaryButtonClass}
						onClick={() => void query.refetch()}
					>
						Refresh local view
					</button>
				</div>
			)}
			{query.isPending && (
				<p className="shared-inbox-empty">Loading cached mentions…</p>
			)}
			{data && items.length === 0 && (
				<div className="shared-inbox-empty">
					<Inbox size={30} />
					<h2>No matching mentions</h2>
					<p>
						{teamTriage
							? "Change the filters, refresh shared state, or ask an operator to connect the dedicated xurl service account. Never import a personal archive into this shared service. Nothing is fetched automatically."
							: "Change the filters, import an archive, or explicitly sync a connected Bird/xurl account. Nothing is fetched automatically."}
					</p>
				</div>
			)}
			<div className="shared-inbox-feed">
				{items.map((item) => (
					<article
						key={item.id}
						className={"shared-inbox-card" + (item.readAt ? " is-read" : "")}
						aria-label={"Tweet by @" + item.authorHandle}
					>
						<div className="shared-inbox-card-top">
							<div className="shared-inbox-avatar" aria-hidden="true">
								{item.authorName.slice(0, 2).toUpperCase()}
							</div>
							<div className="shared-inbox-author">
								<strong>{item.authorName}</strong>
								<span>
									@{item.authorHandle} ·{" "}
									{new Date(item.createdAt).toLocaleDateString(undefined, {
										month: "short",
										day: "numeric",
									})}
								</span>
							</div>
							<span
								className={
									"shared-inbox-reading " + (item.readAt ? "" : "unread")
								}
							>
								{!item.readAt && <Circle size={7} fill="currentColor" />}
								{item.readAt ? "Read" : "Unread"}
							</span>
						</div>
						<div className="shared-inbox-badges">
							{item.targets.map((target) => (
								<span key={target}>
									{target === "openclaw" ? "OpenClaw" : "Peter"}
								</span>
							))}
							{item.classification !== "unclassified" && (
								<span>
									{item.classification === "bug"
										? "Bug report"
										: "Feature request"}
								</span>
							)}
							{item.handledAt && (
								<span>
									<Check size={12} />
									Handled
								</span>
							)}
						</div>
						<p className="shared-inbox-tweet">{item.text}</p>
						<div className="shared-inbox-card-actions">
							{item.url ? (
								<a
									href={item.url}
									target="_blank"
									rel="noopener noreferrer"
									className={secondaryButtonClass}
								>
									Open on X <ArrowUpRight size={14} />
								</a>
							) : (
								<span>Non-X archive ID</span>
							)}
							<button
								className={secondaryButtonClass}
								disabled={busy}
								onClick={() =>
									void mutate(
										{ kind: "read", ids: [item.id], value: !item.readAt },
										item.readAt
											? "Marked unread."
											: "Marked read. Resolution unchanged.",
									)
								}
							>
								{item.readAt ? "Mark unread" : "Mark read"}
							</button>
							<button
								className={secondaryButtonClass}
								disabled={busy}
								onClick={() =>
									void mutate(
										{ kind: "handled", id: item.id, value: !item.handledAt },
										item.handledAt
											? "Reopened. Reading state unchanged."
											: "Marked handled. Reading state unchanged.",
									)
								}
							>
								{item.handledAt ? "Reopen" : "Mark handled"}
							</button>
							<select
								aria-label={"Classify tweet " + item.id}
								value={item.classification}
								disabled={busy}
								onChange={(event) =>
									void mutate(
										{
											kind: "classify",
											id: item.id,
											value: event.target.value,
										},
										"Classification saved; reading and resolution unchanged.",
									)
								}
							>
								<option value="unclassified">Unclassified</option>
								<option value="bug">Bug report</option>
								<option value="feature">Feature request</option>
							</select>
							{capabilities.handoff && (
								<button
									className={secondaryButtonClass}
									disabled={
										busy ||
										!item.url ||
										Boolean(item.handoff && item.handoff.status !== "pending")
									}
									onClick={() => {
										setHandoff(item);
										setClassification(
											item.classification === "feature" ? "feature" : "bug",
										);
										setContext("");
									}}
								>
									<Send size={14} />
									{item.handoff?.status === "pending"
										? "Retry connection"
										: "Send to Roboclaw"}
								</button>
							)}
						</div>
						{item.handoff && (
							<div className="shared-inbox-handoff">
								<strong>
									Roboclaw ·{" "}
									{item.handoff.status === "sending"
										? "in flight / outcome not yet confirmed"
										: item.handoff.status}
								</strong>
								{item.handoff.runId && (
									<span>
										Accepted run: {item.handoff.runId}. Work completion and a
										session link are not confirmed by this hook.
									</span>
								)}
								{item.handoff.error && <span>{item.handoff.error}</span>}
							</div>
						)}
					</article>
				))}
			</div>
			{data && (
				<footer className="shared-inbox-pagination">
					<span>
						{data.total
							? String((filter.offset ?? 0) + 1) +
								"–" +
								String((filter.offset ?? 0) + items.length)
							: "0"}{" "}
						of {data.total} matching tweets · deduplicated by ID
					</span>
					<button
						className={secondaryButtonClass}
						disabled={!filter.offset}
						onClick={() =>
							setFilter((previous) => ({
								...previous,
								offset: Math.max(0, (previous.offset ?? 0) - 30),
							}))
						}
					>
						Previous
					</button>
					<button
						className={secondaryButtonClass}
						disabled={(filter.offset ?? 0) + items.length >= data.total}
						onClick={() =>
							setFilter((previous) => ({
								...previous,
								offset: (previous.offset ?? 0) + 30,
							}))
						}
					>
						Next
					</button>
				</footer>
			)}
			{settings && (
				<SharedInboxModal
					titleId="shared-matches-title"
					onClose={() => setSettings(null)}
				>
					<section className="shared-inbox-modal">
						<h2 id="shared-matches-title">Name matches</h2>
						<p>
							Handles @openclaw and @steipete always match. Add literal names,
							one per line. Changes apply to cached tweets and the next manual
							sync.
						</p>
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void mutate(
									{
										kind: "settings",
										settings: {
											openclaw: settings.openclaw
												.map((name) => name.trim())
												.filter(Boolean),
											peter: settings.peter
												.map((name) => name.trim())
												.filter(Boolean),
										},
									},
									"Name matches saved on the server.",
								).then((ok) => {
									if (ok) setSettings(null);
								});
							}}
						>
							{(["openclaw", "peter"] as const).map((target) => (
								<label key={target}>
									{target === "openclaw" ? "OpenClaw names" : "Peter names"}
									<textarea
										rows={4}
										value={settings[target].join("\n")}
										onChange={(event) =>
											setSettings({
												...settings,
												[target]: event.target.value.split("\n"),
											})
										}
									/>
								</label>
							))}
							<div className="shared-inbox-toolbar">
								<button
									type="submit"
									className={primaryButtonClass}
									disabled={busy}
								>
									Save matches
								</button>
								<button
									type="button"
									className={secondaryButtonClass}
									onClick={() => setSettings(null)}
								>
									Cancel
								</button>
							</div>
						</form>
					</section>
				</SharedInboxModal>
			)}
			{handoff && (
				<SharedInboxModal
					titleId="shared-handoff-title"
					onClose={() => setHandoff(null)}
				>
					<section className="shared-inbox-modal">
						<h2 id="shared-handoff-title">Send to Roboclaw</h2>
						<p>
							The original tweet, author, URL and locally cached reply/quote
							context are included. One handoff per tweet. No X post is sent.
						</p>
						<blockquote>{handoff.text}</blockquote>
						<form onSubmit={(event) => void submitHandoff(event)}>
							<label>
								Report type
								<select
									aria-label="Report type"
									disabled={Boolean(handoff.handoff)}
									value={classification}
									onChange={(event) =>
										setClassification(event.target.value as "bug" | "feature")
									}
								>
									<option value="bug">Bug report</option>
									<option value="feature">Feature request</option>
								</select>
							</label>
							<label>
								Context for Roboclaw
								<textarea
									disabled={Boolean(handoff.handoff)}
									rows={3}
									maxLength={4000}
									placeholder="What should Roboclaw investigate?"
									value={context}
									onChange={(event) => setContext(event.target.value)}
								/>
							</label>
							{handoff.handoff && (
								<p>
									The original handoff payload is preserved; retry only attempts
									its pending connection.
								</p>
							)}
							<p>{data?.integration.detail}</p>
							<div className="shared-inbox-toolbar">
								<button
									className={primaryButtonClass}
									disabled={busy}
									type="submit"
								>
									{data?.integration.configured
										? "Send handoff"
										: "Save pending handoff"}
								</button>
								<button
									type="button"
									className={secondaryButtonClass}
									onClick={() => setHandoff(null)}
								>
									Cancel
								</button>
							</div>
						</form>
					</section>
				</SharedInboxModal>
			)}
		</section>
	);
}

function SharedInboxModal({
	titleId,
	onClose,
	children,
}: {
	titleId: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = ref.current;
		dialog?.showModal();
		return () => dialog?.close();
	}, []);
	return (
		<dialog
			ref={ref}
			className="shared-inbox-dialog"
			aria-labelledby={titleId}
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
		>
			{children}
		</dialog>
	);
}
