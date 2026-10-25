import type { Command as Commander } from "@commander-js/extra-typings";
import type { CommandContext } from "../context";
import type { UiDeps } from "./driver";
import { withUiOptions } from "./ui-options";

/**
 * `record start|note|use|undo|status|cancel|stop` on `warden ui` (called once from `commands/ui.ts`). Only the commander
 * wiring lives here; `authoring-command.ts` (the journal, codegen and the verify run) is imported by the subcommand
 * that runs.
 */
export function registerAuthoringCommands(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: UiDeps
): void {
	const record = cmd
		.command("record")
		.description(
			"turn a warden ui session into an e2e spec: start <name> | note | use <module#fn> | undo | status | cancel | stop. The journal is kept until a successful stop or cancel"
		);
	withUiOptions(
		record
			.command("start")
			.description("start recording; stop writes <suite specsDir>/<name>.e2e.ts (e2e/<name>.e2e.ts without a suite)")
			.argument("<name>", "recording name (the spec file name unless --to)")
			.option("--to <spec>", "spec file to write")
			.option(
				"--helper <module#fn>",
				"write an exported function into a helpers module instead of a spec, e.g. e2e/helpers.ts#signIn"
			)
			.option("--prerequisite <text>", "what must be true before the helper runs (its doc comment); needs --helper")
			.option("--ids <module>", "ids module to merge test ids into (export const ids = { … } as const)")
			.option(
				"--options <module#name>",
				"shared test.use options to pass (e.g. e2e/helpers/steps#SPEC_OPTIONS); default: detected in the specs dir, `none` passes none"
			)
			.option("--title <title>", "the generated test's title (default: the name)")
			.option("--suite <name>", "e2e.<name> suite for the default path and the verify run (needed when several exist)")
			.option(
				"--overwrite",
				"replace an existing spec file, or an existing helper function (the shared --force is for a busy device)"
			)
	).action(async (name, opts) => {
		const { uiRecordStart } = await import("./authoring-command");
		done(await uiRecordStart(ctx, deps, name, opts));
	});
	withUiOptions(
		record
			.command("note")
			.description("mark a user-visible step; the spec gets it as a comment above the next action")
			.argument("<text>", "what the next actions do, e.g. 'enter credentials'")
	).action(async (text, opts) => {
		const { uiRecordNote } = await import("./authoring-command");
		done(await uiRecordNote(ctx, deps, text, opts));
	});
	withUiOptions(
		record
			.command("use")
			.description(
				"run an exported helper on this device and, when it passes, record a call to it (await fn(fixtures)); a failing helper records nothing"
			)
			.argument("<module#fn>", "helpers module (relative to the working directory) and its exported function")
			.option("--suite <name>", "e2e.<name> suite whose spec process runs the helper")
	).action(async (ref, opts) => {
		const { uiRecordUse } = await import("./authoring-command");
		done(await uiRecordUse(ctx, deps, ref, opts));
	});
	withUiOptions(
		record
			.command("undo")
			.description("drop the last recorded step(s), notes included")
			.argument("[n]", "how many steps (default 1)")
	).action(async (n, opts) => {
		const { uiRecordUndo } = await import("./authoring-command");
		done(await uiRecordUndo(ctx, deps, n, opts));
	});
	withUiOptions(
		record.command("status").description("target, step count, the last 5 steps and the lints so far")
	).action(async (opts) => {
		const { uiRecordStatus } = await import("./authoring-command");
		done(await uiRecordStatus(ctx, deps, opts));
	});
	withUiOptions(
		record.command("cancel").description("throw the recording away (a spec already written is left)")
	).action(async (opts) => {
		const { uiRecordCancel } = await import("./authoring-command");
		done(await uiRecordCancel(ctx, deps, opts));
	});
	withUiOptions(
		record
			.command("stop")
			.description(
				"write the spec (or helper), merge ids, print lints, then run the spec once on this device; exit 1 keeps the file AND the journal so you can undo, fix and stop again"
			)
			.option("--no-verify", "write the file without running it (always the case for --helper)")
			.option("--suite <name>", "e2e.<name> suite to verify in")
			.option(
				"--overwrite",
				"replace an existing spec file, or an existing helper function (the shared --force is for a busy device)"
			)
	).action(async (opts) => {
		const { uiRecordStop } = await import("./authoring-command");
		done(await uiRecordStop(ctx, deps, opts));
	});
}
