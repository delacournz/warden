import { type CloseOptionValues, uiClose } from "../agent-ui/close";
import { defaultUiDeps, type UiDeps } from "../agent-ui/driver";
import { withUiOptions } from "../agent-ui/run";
import { uiFind, uiSnapshot } from "../agent-ui/snapshot-command";
import { uiStatus } from "../agent-ui/status";
import { type Command, defineCommand } from "../command";

/**
 * `warden ui <subcommand>`: drive a leased device for agents. Every subcommand is one `cmd.command(...)`
 * calling a function in `agent-ui/*.ts`, takes the options of `withUiOptions`, and honours the lease
 * rules of `resolveUiDevice` (the hook's `ensureCallerLease`). Exit codes: 0 ok · 1 failed/usage · 2 lease
 * · 3 engine unavailable · 4 stale ref · 130 interrupted. `deps` injects the driver + clock for tests.
 */
export function createUiCommand(deps: UiDeps): Command {
	return defineCommand({
		name: "ui",
		summary: "drive a leased simulator / emulator (agents): status, snapshot, find, …",
		register: (cmd, ctx, done) => {
			withUiOptions(cmd.command("status").description("device, lease, helper and recording state")).action(
				async (opts) => done(await uiStatus(ctx, deps, opts))
			);
			withUiOptions(
				cmd
					.command("close")
					.description(
						"stop this device's helper (the lease stays); --app also quits the app, --release frees the lease"
					)
					.option("--app [bundleId]", "terminate the app first (default: the one `open` launched)")
					.option("--release", "release the lease too (stops the helper)")
			).action(async (opts: CloseOptionValues) => done(await uiClose(ctx, deps, opts)));
			withUiOptions(
				cmd
					.command("snapshot")
					.description("the screen as @eN lines (bumps the generation)")
					.option("-i, --interactive", "only interactive elements and anything with a testID")
					.option("--all", "no line cap")
					.option("--settle [ms]", "wait for a quiet screen (default budget 3000 ms), then print a +/-/= diff")
					.option("--depth <n>", "only the first n levels of the tree")
			).action(async (opts) => done(await uiSnapshot(ctx, deps, opts)));
			withUiOptions(
				cmd
					.command("find")
					.description("elements matching a selector, with @eN refs (bumps the generation)")
					.argument("<selector...>", "id=… label=… text=… role=… value=… editable=… nth=…")
			).action(async (selector, opts) => done(await uiFind(ctx, deps, selector, opts)));
		},
	});
}

export const uiCommand = createUiCommand(defaultUiDeps);
