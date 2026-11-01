import type { Command as Commander } from "@commander-js/extra-typings";
import type { CommandContext } from "../context";
import { DEFAULT_TAIL, uiDevtoolsRegister } from "./devtools-register";
import type { UiDeps } from "./driver";
import { uiOptionsHelper } from "./ui-options";

export class UiNetworkRegister {
	private withLogOptions<
		Args extends unknown[],
		Opts extends Record<string, unknown>,
		Globals extends Record<string, unknown>,
	>(cmd: Commander<Args, Opts, Globals>) {
		return cmd
			.option("--include <parts>", "headers,body")
			.option("--id <id>", "one entry in full")
			.option("--grep <text>", "only URLs containing text (case-insensitive)")
			.option("--status <status>", "only this status: 404 | 4xx")
			.option("--limit <n>", "at most the last n entries");
	}

	/**
	 * `warden ui network`: a command group. `log` is the app's recorded fetch calls (devtools), `set` / `flap` / `fault` /
	 * `status` / `reset` are the lease-scoped network conditions. Bare `network [n] --since ...` is the old request-log
	 * form, kept as a hidden alias of `log` that prints one stderr note. One call from `commands/ui.ts`; the
	 * implementations (`devtools-cli.ts`, `conditions.ts`) are imported by the subcommand that runs.
	 */
	registerNetworkGroup(cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: UiDeps): void {
		const group = this.withLogOptions(
			uiOptionsHelper.withUiOptions(
				uiDevtoolsRegister.withSince(
					cmd
						.command("network")
						.description(
							"the app's network: log (recorded requests) | set | flap | fault | status | reset (device conditions)"
						)
						.argument("[n]", `deprecated: same as \`network log [n]\` (default ${DEFAULT_TAIL})`)
				)
			)
		);
		group.enablePositionalOptions();
		for (const option of group.options) option.hideHelp();
		group.action(async (n, opts) => {
			if (opts.json !== true) ctx.err("warden ui network is now warden ui network log");
			const { uiDevtoolsCli } = await import("./devtools-cli");
			done(await uiDevtoolsCli.uiNetwork(ctx, deps, n, opts));
		});

		this.withLogOptions(
			uiOptionsHelper.withUiOptions(
				uiDevtoolsRegister.withSince(
					group
						.command("log")
						.description("the app's fetch calls recorded by `logs start` or the dev session")
						.argument("[n]", `entries to show (default ${DEFAULT_TAIL})`)
				)
			)
		).action(async (n, opts) => {
			const { uiDevtoolsCli } = await import("./devtools-cli");
			done(await uiDevtoolsCli.uiNetwork(ctx, deps, n, opts));
		});

		uiOptionsHelper
			.withUiOptions(
				group
					.command("set")
					.description("change the device network: online | offline | edge | 3g | 4g | lte | wifi | slow | lossy")
					.argument("<condition>", "online | offline | edge | 3g | 4g | lte | wifi | slow | lossy")
					.option("--latency <ms>", "added round-trip time (overrides the preset's)")
					.option("--jitter <ms>", "ms of jitter")
					.option("--down <kbps>", "kbps down")
					.option("--up <kbps>", "kbps up")
					.option("--loss <pct>", "packet loss, 0-100")
					.option(
						"--relaunch",
						"iOS: relaunch the app with the network dylib when it runs without (else E_NETWORK_RELAUNCH)"
					)
			)
			.action(async (condition, opts) => {
				const { uiConditions } = await import("./conditions");
				done(await uiConditions.uiNetSet(ctx, deps, condition, opts));
			});

		uiOptionsHelper
			.withUiOptions(
				group
					.command("flap")
					.description("alternate the network up and down on a schedule")
					.option("--up <dur>", "how long the network stays up (default 3s)")
					.option("--down <dur>", "how long the network is down (default 10s)")
					.option("--jitter <pct>", "percent of phase length")
					.option("--seed <n>", "same seed, same sequence (default 1)")
					.option("--relaunch", "iOS: relaunch the app with the network dylib when it runs without")
			)
			.action(async (opts) => {
				const { uiConditions } = await import("./conditions");
				done(await uiConditions.uiNet(ctx, deps, "flap", [], opts));
			});

		uiOptionsHelper
			.withUiOptions(
				group
					.command("fault")
					.description("fail requests to a host: status:503 | reset | delay:2s | blackhole (--clear removes all)")
					.argument("[args...]", "<host-glob> <status:503|reset|delay:2s|blackhole>")
					.option("--clear", "remove every fault")
			)
			.action(async (args, opts) => {
				const { uiConditions } = await import("./conditions");
				done(await uiConditions.uiNet(ctx, deps, "fault", args, opts));
			});

		uiOptionsHelper
			.withUiOptions(group.command("status").description("the network condition recorded on the lease"))
			.action(async (opts) => {
				const { uiConditions } = await import("./conditions");
				done(await uiConditions.uiNet(ctx, deps, "status", [], opts));
			});

		uiOptionsHelper
			.withUiOptions(
				group.command("reset").description("network back to normal; stops the flap scheduler and clears faults")
			)
			.action(async (opts) => {
				const { uiConditions } = await import("./conditions");
				done(await uiConditions.uiNet(ctx, deps, "reset", [], opts));
			});
	}
}

export const uiNetworkRegister = new UiNetworkRegister();
