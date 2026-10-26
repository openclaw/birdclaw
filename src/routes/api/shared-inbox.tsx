import { createFileRoute } from "@tanstack/react-router";
import { sensitiveRequestErrorResponse, jsonResponse } from "#/lib/http-effect";
import { enqueueDatabaseWrite } from "#/lib/database-writer";
import {
	listSharedInbox,
	saveSharedInboxSettings,
	sharedInboxFilterSchema,
	sharedInboxMutationSchema,
	updateSharedInboxState,
} from "#/lib/shared-inbox";
import { sendSharedInboxHandoff } from "#/lib/shared-inbox-handoff";
import {
	syncSharedInbox,
	SharedInboxSyncBusyError,
	teamSourceReadiness,
} from "#/lib/shared-inbox-sync";
import { isTeamTriage, teamTriageCapabilities } from "#/lib/team-triage";
import { ZodError } from "zod";

function privateJson(value: unknown, status = 200) {
	return jsonResponse(value, {
		status,
		headers: { "cache-control": "no-store" },
	});
}
export function getSharedInbox(request: Request) {
	const denied = sensitiveRequestErrorResponse(request);
	if (denied) return denied;
	try {
		const query = sharedInboxFilterSchema.parse(
			Object.fromEntries(new URL(request.url).searchParams),
		);
		return privateJson(listSharedInbox(query));
	} catch (error) {
		return privateJson(
			{
				message:
					error instanceof ZodError
						? "Invalid shared inbox filters"
						: "Shared inbox could not be read",
			},
			error instanceof ZodError ? 400 : 500,
		);
	}
}
export async function postSharedInbox(request: Request) {
	const denied = sensitiveRequestErrorResponse(request);
	if (denied) return denied;
	let input;
	try {
		input = sharedInboxMutationSchema.parse(await request.json());
	} catch {
		return privateJson({ message: "Invalid shared inbox action" }, 400);
	}
	try {
		const capabilities = teamTriageCapabilities();
		if (
			(input.kind === "settings" && !capabilities.settings) ||
			(input.kind === "handoff" && !capabilities.handoff)
		)
			return privateJson(
				{
					message:
						"This action requires operator setup and is disabled in Team triage",
				},
				403,
			);
		if (input.kind === "handoff")
			return privateJson({ handoff: await sendSharedInboxHandoff(input) });
		if (input.kind === "sync") {
			if (
				isTeamTriage() &&
				(input.account !== undefined || !teamSourceReadiness().configured)
			)
				return privateJson(
					{
						message:
							"The dedicated Team source is not ready or a client account override was supplied",
					},
					403,
				);
			const result = await syncSharedInbox(input.account);
			return result.ok
				? privateJson({ ok: true, count: result.count, source: result.source })
				: privateJson(
						{
							message:
								"Live sync failed. Check the dedicated source; cached rows are not current coverage.",
						},
						502,
					);
		}
		await enqueueDatabaseWrite((db) => {
			if (input.kind === "settings")
				saveSharedInboxSettings(input.settings, db);
			else updateSharedInboxState(input, db);
		});
		return privateJson({ ok: true });
	} catch (error) {
		if (error instanceof SharedInboxSyncBusyError)
			return jsonResponse(
				{ message: error.message },
				{
					status: isTeamTriage() ? 429 : 409,
					headers: {
						"retry-after": String(error.retryAfterSeconds),
						"cache-control": "no-store",
					},
				},
			);
		return privateJson(
			{
				message:
					"Action could not be completed. Check local tweet availability and server connection configuration.",
			},
			500,
		);
	}
}
export const Route = createFileRoute("/api/shared-inbox")({
	server: {
		handlers: {
			GET: ({ request }) => getSharedInbox(request),
			POST: ({ request }) => postSharedInbox(request),
		},
	},
});
