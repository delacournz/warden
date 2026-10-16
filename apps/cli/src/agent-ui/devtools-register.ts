import type { Command as Commander } from "@commander-js/extra-typings";
import type { CommandContext } from "../context";
import type { UiDeps } from "./driver";
import { withUiOptions } from "./ui-options";

/** Default number of lines `logs` / `network` show. */
export const DEFAULT_TAIL = 50;

const withMetro = <
	Args extends unknown[],
	Opts extends Record<string, unknown>,
	Globals extends Record<string, unknown>,
>(
	cmd: Commander<Args, Opts, Globals>
) => cmd.option("--metro <url>", "Metro URL (default: WARDEN_METRO_URL, state.json, then this owner's leased ports)");

/**
 * The devtools subcommands of `warden ui`: eval, tree, logs, network, reload. One call from `commands/ui.ts`.
 * Only the commander wiring lives here; `devtools-cli.ts` (Metro, the e2e devtools facet) is imported by the
 * subcommand that runs. `deps.devtools` replaces the real Metro / collector side effects in tests.
 */
export function registerDevtoolsCommands(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: UiDeps
): void {
	withMetro(
		withUiOptions(
			cmd
				.command("eval")
				.description("run JavaScript in the app (Hermes) and print the value")
				.argument("<expression>", "JavaScript expression")
				.option("--await", "await a returned promise")
		)
	).action(async (expression, opts) => {
		const { uiEval } = await import("./devtools-cli");
		done(await uiEval(ctx, deps, expression, opts));
	});
	withMetro(
		withUiOptions(
			cmd
				.command("tree")
				.description("the app's React components (testID, label, text, screen) with rects")
				.option("--all", "include inactive screens and unmeasured components")
				.option("--max <n>", "at most n components")
				.option("--screen <name>", "only this screen's subtree (react-navigation / expo-router route name)")
		)
	).action(async (opts) => {
		const { uiTree } = await import("./devtools-cli");
		done(await uiTree(ctx, deps, opts));
	});
	withMetro(
		withUiOptions(
			cmd
				.command("logs")
				.description("app console: logs [n] | start | stop | mark <label> | clear")
				.argument("[args...]", "n, or start | stop | mark <label> | clear")
				.option("--bodies", "with start: also record request and response bodies")
		)
	).action(async (words, opts) => {
		const { uiLogs } = await import("./devtools-cli");
		done(await uiLogs(ctx, deps, words, opts));
	});
	withUiOptions(
		cmd
			.command("network")
			.description("the app's fetch calls recorded by `logs start`")
			.argument("[n]", `entries to show (default ${DEFAULT_TAIL})`)
			.option("--include <parts>", "headers,body")
			.option("--id <id>", "one entry in full")
	).action(async (n, opts) => {
		const { uiNetwork } = await import("./devtools-cli");
		done(await uiNetwork(ctx, deps, n, opts));
	});
	withMetro(withUiOptions(cmd.command("reload").description("reload the app's JavaScript"))).action(async (opts) => {
		const { uiReload } = await import("./devtools-cli");
		done(await uiReload(ctx, deps, opts));
	});
}
