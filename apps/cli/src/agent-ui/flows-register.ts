import type { Command as Commander } from "@commander-js/extra-typings";
import type { CommandContext } from "../context";
import type { UiDeps } from "./driver";
import { withUiOptions } from "./ui-options";

/**
 * `record start|stop|status`, `replay` and `export` on `warden ui` (called once from `commands/ui.ts`). Only the
 * commander wiring lives here; `flows-command.ts` (the e2e flow modules) is imported by the subcommand that runs.
 */
export function registerFlowCommands(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: UiDeps
): void {
	const record = cmd
		.command("record")
		.description("record warden ui actions as a replayable flow: start <name> | stop | status");
	withUiOptions(
		record
			.command("start")
			.description("start recording to .warden-ui/<name>.flow.json")
			.argument("<name>", "flow name")
			.option("--out <file>", "write the flow here instead")
	).action(async (name, opts) => {
		const { uiRecordStart } = await import("./flows-command");
		done(await uiRecordStart(ctx, deps, name, opts));
	});
	withUiOptions(record.command("stop").description("stop recording and print the step count")).action(async (opts) => {
		const { uiRecordStop } = await import("./flows-command");
		done(await uiRecordStop(ctx, deps, opts));
	});
	withUiOptions(record.command("status").description("is a recording running, and how long is it")).action(
		async (opts) => {
			const { uiRecordStatus } = await import("./flows-command");
			done(await uiRecordStatus(ctx, deps, opts));
		}
	);
	withUiOptions(
		cmd
			.command("replay")
			.description("re-run a recorded flow; a screen that no longer matches is a replay_divergence (exit 1)")
			.argument("<file>", "a .flow.json")
			.option("--from <i>", "start at this step index")
			.option("--update-snapshots", "rewrite the file with the positions and screen hashes seen now")
			.option("--settle [ms]", "settle after every step, not only the recorded ones (default budget 3000 ms)")
	).action(async (file, opts) => {
		const { uiReplay } = await import("./flows-command");
		done(await uiReplay(ctx, deps, file, opts));
	});
	cmd
		.command("export")
		.description("write a recorded flow as an e2e spec for @delacour/warden-e2e")
		.argument("<file>", "a .flow.json")
		.requiredOption("--to <path>", "spec file to write, e.g. e2e/sign-in.e2e.ts")
		.option("--ids <path>", "ids module to merge test ids into (export const ids = { … })")
		.option("--force", "overwrite an existing spec")
		.option("--json", "machine-readable output: one JSON document on stdout")
		.action(async (file, opts) => {
			const { uiExport } = await import("./flows-command");
			done(await uiExport(ctx, file, opts));
		});
}
