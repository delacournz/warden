import type { Command as Commander } from "@commander-js/extra-typings";
import type { CommandContext } from "../context";
import type { UiDeps } from "./driver";
import { registerLogpoint } from "./logpoint-cli";
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

export const withSince = <
	Args extends unknown[],
	Opts extends Record<string, unknown>,
	Globals extends Record<string, unknown>,
>(
	cmd: Commander<Args, Opts, Globals>
) => cmd.option("--since <when>", "only entries from the last <dur> (30s, 5m, 2h) or after an ISO time");

/**
 * The devtools subcommands of `warden ui`: eval, tree, logs, exceptions, route, reload, devtools. One call from `commands/ui.ts`.
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
			withSince(
				cmd
					.command("logs")
					.description("app console: logs [n] | start | stop | mark <label> | clear")
					.argument("[args...]", "n, or start | stop | mark <label> | clear")
			)
				.option("--bodies", "with start: also record request and response bodies")
				.option("--level <level>", "at least this level: debug | log | info | warn | error")
				.option("--grep <text>", "only lines containing text (case-insensitive)")
				.option("--limit <n>", "at most the last n lines")
		)
	).action(async (words, opts) => {
		const { uiLogs } = await import("./devtools-cli");
		done(await uiLogs(ctx, deps, words, opts));
	});
	withMetro(withUiOptions(cmd.command("reload").description("reload the app's JavaScript"))).action(async (opts) => {
		const { uiReload } = await import("./devtools-cli");
		done(await uiReload(ctx, deps, opts));
	});
	withUiOptions(
		withSince(cmd.command("exceptions").description("the app's uncaught exceptions")).option(
			"--limit <n>",
			"at most the last n exceptions"
		)
	).action(async (opts) => {
		const { uiExceptions } = await import("./devtools-cli");
		done(await uiExceptions(ctx, deps, opts));
	});
	withMetro(withUiOptions(cmd.command("route").description("the route key of the screen the app is on"))).action(
		async (opts) => {
			const { uiRoute } = await import("./devtools-cli");
			done(await uiRoute(ctx, deps, opts));
		}
	);
	const devtools = cmd.command("devtools").description("the dev session's devtools broker: status | resume");
	withUiOptions(devtools.command("status").description("what the broker is doing: attached, yielded, lost")).action(
		async (opts) => {
			const { uiDevtoolsStatus } = await import("./devtools-cli");
			done(await uiDevtoolsStatus(ctx, deps, opts));
		}
	);
	withUiOptions(
		devtools.command("resume").description("take the page back after the broker yielded to Chrome DevTools")
	).action(async (opts) => {
		const { uiDevtoolsResume } = await import("./devtools-cli");
		done(await uiDevtoolsResume(ctx, deps, opts));
	});
	registerLogpoint(cmd, ctx, done);
}
