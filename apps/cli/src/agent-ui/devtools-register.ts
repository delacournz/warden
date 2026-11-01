import type { Command as Commander } from "@commander-js/extra-typings";
import type { CommandContext } from "../context";
import type { UiDeps } from "./driver";
import { uiLogpointCli } from "./logpoint-cli";
import { uiOptionsHelper } from "./ui-options";

/** Default number of lines `logs` / `network` show. */
export const DEFAULT_TAIL = 50;

export class UiDevtoolsRegister {
	private withMetro<
		Args extends unknown[],
		Opts extends Record<string, unknown>,
		Globals extends Record<string, unknown>,
	>(cmd: Commander<Args, Opts, Globals>) {
		return cmd.option(
			"--metro <url>",
			"Metro URL (default: WARDEN_METRO_URL, state.json, then this owner's leased ports)"
		);
	}

	withSince<Args extends unknown[], Opts extends Record<string, unknown>, Globals extends Record<string, unknown>>(
		cmd: Commander<Args, Opts, Globals>
	) {
		return cmd.option("--since <when>", "only entries from the last <dur> (30s, 5m, 2h) or after an ISO time");
	}

	/**
	 * The devtools subcommands of `warden ui`: eval, tree, logs, exceptions, route, reload, devtools. One call from `commands/ui.ts`.
	 * Only the commander wiring lives here; `devtools-cli.ts` (Metro, the e2e devtools facet) is imported by the
	 * subcommand that runs. `deps.devtools` replaces the real Metro / collector side effects in tests.
	 */
	registerDevtoolsCommands(cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: UiDeps): void {
		this.withMetro(
			uiOptionsHelper.withUiOptions(
				cmd
					.command("eval")
					.description("run JavaScript in the app (Hermes) and print the value")
					.argument("<expression>", "JavaScript expression")
					.option("--await", "await a returned promise")
			)
		).action(async (expression, opts) => {
			const { uiDevtoolsCli } = await import("./devtools-cli");
			done(await uiDevtoolsCli.uiEval(ctx, deps, expression, opts));
		});
		this.withMetro(
			uiOptionsHelper.withUiOptions(
				cmd
					.command("tree")
					.description("the app's React components (testID, label, text, screen) with rects")
					.option("--all", "include inactive screens and unmeasured components")
					.option("--max <n>", "at most n components")
					.option("--screen <name>", "only this screen's subtree (react-navigation / expo-router route name)")
			)
		).action(async (opts) => {
			const { uiDevtoolsCli } = await import("./devtools-cli");
			done(await uiDevtoolsCli.uiTree(ctx, deps, opts));
		});
		this.withMetro(
			uiOptionsHelper.withUiOptions(
				this.withSince(
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
			const { uiDevtoolsCli } = await import("./devtools-cli");
			done(await uiDevtoolsCli.uiLogs(ctx, deps, words, opts));
		});
		this.withMetro(
			uiOptionsHelper.withUiOptions(cmd.command("reload").description("reload the app's JavaScript"))
		).action(async (opts) => {
			const { uiDevtoolsCli } = await import("./devtools-cli");
			done(await uiDevtoolsCli.uiReload(ctx, deps, opts));
		});
		uiOptionsHelper
			.withUiOptions(
				this.withSince(cmd.command("exceptions").description("the app's uncaught exceptions")).option(
					"--limit <n>",
					"at most the last n exceptions"
				)
			)
			.action(async (opts) => {
				const { uiDevtoolsCli } = await import("./devtools-cli");
				done(await uiDevtoolsCli.uiExceptions(ctx, deps, opts));
			});
		this.withMetro(
			uiOptionsHelper.withUiOptions(cmd.command("route").description("the route key of the screen the app is on"))
		).action(async (opts) => {
			const { uiDevtoolsCli } = await import("./devtools-cli");
			done(await uiDevtoolsCli.uiRoute(ctx, deps, opts));
		});
		const devtools = cmd.command("devtools").description("the dev session's devtools broker: status | resume");
		uiOptionsHelper
			.withUiOptions(devtools.command("status").description("what the broker is doing: attached, yielded, lost"))
			.action(async (opts) => {
				const { uiDevtoolsCli } = await import("./devtools-cli");
				done(await uiDevtoolsCli.uiDevtoolsStatus(ctx, deps, opts));
			});
		uiOptionsHelper
			.withUiOptions(
				devtools.command("resume").description("take the page back after the broker yielded to Chrome DevTools")
			)
			.action(async (opts) => {
				const { uiDevtoolsCli } = await import("./devtools-cli");
				done(await uiDevtoolsCli.uiDevtoolsResume(ctx, deps, opts));
			});
		uiLogpointCli.registerLogpoint(cmd, ctx, done);
	}
}

export const uiDevtoolsRegister = new UiDevtoolsRegister();
