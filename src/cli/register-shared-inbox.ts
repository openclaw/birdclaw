import { initializeTeamTriageAuthHome } from "#/lib/team-triage";
import {
	initializeTeamTriageStore,
	configureTeamTriageAccount,
	configureTeamGrokSource,
} from "#/lib/team-triage-store";
import { syncSharedInbox } from "#/lib/shared-inbox-sync";
import type { CliCommandContext } from "./command-context";
import {
	getSharedInboxSettings,
	listSharedInbox,
	sharedInboxFilterSchema,
	sharedInboxMutationSchema,
	updateSharedInboxState,
	saveSharedInboxSettings,
} from "#/lib/shared-inbox";
import { sendSharedInboxHandoff } from "#/lib/shared-inbox-handoff";

export function registerSharedInboxCommands({
	program,
	print,
	asJson,
}: CliCommandContext) {
	const shared = program
		.command("shared-inbox")
		.description("Local shared OpenClaw/Peter mentions and durable triage");
	shared
		.command("init-team")
		.description(
			"Initialize only an empty dedicated private mentions store; never imports an archive",
		)
		.action(() => print(initializeTeamTriageStore(), asJson()));
	shared
		.command("init-team-auth-home")
		.description("Admit only an empty dedicated xurl authentication HOME")
		.action(() => print(initializeTeamTriageAuthHome(), asJson()));
	shared
		.command("configure-team-account <handle> <userId>")
		.description(
			"Bind explicit service account metadata; does not establish an X login",
		)
		.action((handle: string, userId: string) =>
			print(configureTeamTriageAccount(handle, userId), asJson()),
		);
	shared
		.command("configure-team-grok-source")
		.description(
			"Configure local Grok ingestion ownership; requires no X login and does not verify the key",
		)
		.action(() => print(configureTeamGrokSource(), asJson()));
	shared
		.command("list")
		.option("--target <target>", "all, openclaw, peter", "all")
		.option("--read <state>", "all, unread, read", "all")
		.option("--handled <state>", "all, open, handled", "all")
		.option("--classification <type>", "all, unclassified, bug, feature", "all")
		.option("--search <text>", "Literal local text search", "")
		.option("--offset <n>", "Pagination offset", "0")
		.option("--limit <n>", "Page size (1–100)", "30")
		.action((options) =>
			print(listSharedInbox(sharedInboxFilterSchema.parse(options)), asJson()),
		);
	for (const [name, kind, value] of [
		["read", "read", true],
		["unread", "read", false],
		["handle", "handled", true],
		["reopen", "handled", false],
	] as const) {
		shared.command(name + " <tweetId>").action((id: string) => {
			updateSharedInboxState(
				kind === "read" ? { kind, ids: [id], value } : { kind, id, value },
			);
			print({ ok: true, id, kind, value }, asJson());
		});
	}
	shared
		.command("classify <tweetId> <type>")
		.action((id: string, value: string) => {
			const action = sharedInboxMutationSchema.parse({
				kind: "classify",
				id,
				value,
			});
			if (action.kind === "classify") updateSharedInboxState(action);
			print({ ok: true, id, classification: value }, asJson());
		});
	shared
		.command("names")
		.option("--openclaw <names>", "Comma-separated literal OpenClaw names")
		.option("--peter <names>", "Comma-separated literal Peter names")
		.action((options) => {
			const settings = getSharedInboxSettings();
			for (const target of ["openclaw", "peter"] as const)
				if (options[target] !== undefined)
					settings[target] = String(options[target])
						.split(",")
						.map((name) => name.trim())
						.filter(Boolean);
			print(
				options.openclaw !== undefined || options.peter !== undefined
					? saveSharedInboxSettings(settings)
					: settings,
				asJson(),
			);
		});
	shared
		.command("sync")
		.option(
			"--account <selector>",
			"Existing account for bounded explicit Bird/xurl search",
		)
		.action(async (options) => {
			print(await syncSharedInbox(options.account), asJson());
		});
	shared
		.command("send <tweetId>")
		.requiredOption("--type <type>", "bug or feature")
		.option("--context <text>", "Operator context", "")
		.action(async (id: string, options) => {
			const action = sharedInboxMutationSchema.parse({
				kind: "handoff",
				id,
				classification: options.type,
				context: options.context,
			});
			if (action.kind === "handoff")
				print({ handoff: await sendSharedInboxHandoff(action) }, asJson());
		});
}
