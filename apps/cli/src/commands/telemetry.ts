import { Argument } from "@commander-js/extra-typings";
import type { OptOutReason, Telemetry, TelemetryStatus } from "@delacournz/cli-telemetry";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit } from "../output";
import { telemetry as sharedTelemetry, TELEMETRY_DOCS_URL } from "../telemetry/client";

/**
 * `warden telemetry [status|enable|disable]`.
 *
 * The way to see what warden would do and to change it, without reading documentation or knowing an
 * environment variable. Output goes to stdout like `version` and `ls`, `--json` included, and it is the one
 * command that is neither announced by the first-run notice nor counted: see `telemetry/tracker.ts`.
 */

export const TELEMETRY_ACTIONS = ["status", "enable", "disable"] as const;
export type TelemetryAction = (typeof TELEMETRY_ACTIONS)[number];

const REASONS: Record<OptOutReason, string> = {
	default: "on by default; nothing has switched it off",
	"stored-enabled": "switched on with `warden telemetry enable`",
	"do-not-track": "DO_NOT_TRACK is set",
	"delacour-env": "DELACOUR_TELEMETRY_DISABLED is set",
	"product-env": "WARDEN_TELEMETRY_DISABLED is set",
	"stored-disabled": "switched off with `warden telemetry disable`",
	"test-env": "NODE_ENV is `test`",
	"dev-version": "this is a development or local build, which never reports",
};

export function describeReason(reason: OptOutReason): string {
	return REASONS[reason];
}

export function formatStatus(status: TelemetryStatus): string {
	const lines = [
		`Telemetry is ${status.enabled ? "enabled" : "disabled"}: ${describeReason(status.reason)}.`,
		"",
		`Endpoint:    ${status.endpoint}`,
		`Config file: ${status.storePath}`,
	];
	if (status.machineId) lines.push(`Machine ID:  ${status.machineId}`);
	if (status.debug)
		lines.push("", "DELACOUR_TELEMETRY_DEBUG is set: events are printed to stderr and nothing is sent.");
	if (!status.persistent) lines.push("", "The config file could not be saved, so this choice lasts for this run only.");
	lines.push(
		"",
		status.enabled ? "Turn it off with `warden telemetry disable`." : "Turn it on with `warden telemetry enable`.",
		`What is collected: ${TELEMETRY_DOCS_URL}`
	);
	return lines.join("\n");
}

export function runTelemetry(
	ctx: CommandContext,
	action: TelemetryAction,
	options: { json?: boolean },
	telemetry: Telemetry
): void {
	if (action === "enable") telemetry.enable();
	if (action === "disable") telemetry.disable();
	const status = telemetry.status();
	const stays =
		action === "enable" && !status.enabled ? `Telemetry stays off: ${describeReason(status.reason)}.\n\n` : "";
	emit(ctx, options.json === true, status, `${stays}${formatStatus(status)}`);
}

export const telemetryCommand = defineCommand({
	name: "telemetry",
	group: "Setup",
	summary: "see, enable or disable anonymous usage telemetry",
	register: (cmd, ctx, done) => {
		cmd
			.addArgument(
				new Argument("[action]", "show the current setting, or switch telemetry on or off")
					.choices(TELEMETRY_ACTIONS)
					.default("status" as const)
			)
			.option("--json", "machine-readable output")
			.action((action, opts) => {
				runTelemetry(ctx, action, opts, sharedTelemetry());
				done(0);
			});
	},
});
