import type { Command as Commander } from "@commander-js/extra-typings";
import { durationParser } from "@delacour/warden-config/duration";
import { perfLsOps } from "@delacour/warden-sdk/ops/perf/ls";
import type { CommandContext } from "../context";
import { output } from "../output";
import { perfDeviceCli } from "./device";
import type { PerfDeps } from "./run";

export type PerfLsOptions = { json?: true; devices?: true; device?: string };

export class PerfLsCli {
	/** `warden perf ls`: recorded sessions (newest first), or with `--devices` the warden devices a session could attach to. */
	async perfLs(ctx: CommandContext, deps: PerfDeps, opts: PerfLsOptions): Promise<number> {
		const json = opts.json === true;
		const { color } = ctx.ui;
		if (opts.devices === true) {
			const devices = await perfDeviceCli.listPerfCandidates(ctx, deps.device);
			const text =
				devices.length === 0
					? color.dim("no booted warden devices")
					: output.table(
							ctx,
							["UDID", "PLATFORM", "NAME", "HELD BY", "APP"],
							devices.map((d) => [d.udid, d.platform, d.name, d.holder ?? "", d.app ?? ""])
						);
			output.emit(ctx, json, { devices }, text, { scope: "perf ls", detail: output.plural(devices.length, "device") });
			return 0;
		}
		const now = ctx.now();
		const rows = perfLsOps.sessionRows(ctx, opts.device);
		const text =
			rows.length === 0
				? color.dim("no perf sessions")
				: output.table(
						ctx,
						["SESSION", "DEVICE", "APP", "STATUS", "AGE", "CAP", "MARKS"],
						rows.map((r) => [
							r.id,
							r.device,
							r.app ?? "",
							r.status === "running"
								? color.green(r.status)
								: r.status === "stopped"
									? r.status
									: color.yellow(r.status),
							durationParser.format(now - r.startedAt),
							durationParser.format(r.maxDurationMs),
							String(r.marks),
						]),
						{ column: 2, keep: "end" }
					);
		output.emit(ctx, json, { sessions: rows }, text, {
			scope: "perf ls",
			detail: output.plural(rows.length, "session"),
		});
		return 0;
	}

	/** Wire `ls` onto `warden perf`. */
	readonly registerLs = (cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void => {
		cmd
			.command("ls")
			.description("perf sessions (newest first); --devices lists the warden devices a session could attach to")
			.option("--devices", "list candidate devices (booted, warden's) with holder and foreground app")
			.option("--device <udid>", "only this device's sessions")
			.option("--json", "machine-readable output")
			.action(async (opts) => {
				done(await this.perfLs(ctx, deps, opts));
			});
	};
}

export const perfLsCli = new PerfLsCli();
