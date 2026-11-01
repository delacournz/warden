import type { Command as Commander } from "@commander-js/extra-typings";
import { formatDuration } from "@delacour/warden-config/duration";
import { sessionRows } from "@delacour/warden-sdk/ops/perf/ls";
import type { CommandContext } from "../context";
import { emit, plural, table } from "../output";
import { listPerfCandidates } from "./device";
import type { PerfDeps } from "./run";

export type PerfLsOptions = { json?: true; devices?: true; device?: string };

/** `warden perf ls`: recorded sessions (newest first), or with `--devices` the warden devices a session could attach to. */
export async function perfLs(ctx: CommandContext, deps: PerfDeps, opts: PerfLsOptions): Promise<number> {
	const json = opts.json === true;
	const { color } = ctx.ui;
	if (opts.devices === true) {
		const devices = await listPerfCandidates(ctx, deps.device);
		const text =
			devices.length === 0
				? color.dim("no booted warden devices")
				: table(
						ctx,
						["UDID", "PLATFORM", "NAME", "HELD BY", "APP"],
						devices.map((d) => [d.udid, d.platform, d.name, d.holder ?? "", d.app ?? ""])
					);
		emit(ctx, json, { devices }, text, { scope: "perf ls", detail: plural(devices.length, "device") });
		return 0;
	}
	const now = ctx.now();
	const rows = sessionRows(ctx, opts.device);
	const text =
		rows.length === 0
			? color.dim("no perf sessions")
			: table(
					ctx,
					["SESSION", "DEVICE", "APP", "STATUS", "AGE", "CAP", "MARKS"],
					rows.map((r) => [
						r.id,
						r.device,
						r.app ?? "",
						r.status === "running" ? color.green(r.status) : r.status === "stopped" ? r.status : color.yellow(r.status),
						formatDuration(now - r.startedAt),
						formatDuration(r.maxDurationMs),
						String(r.marks),
					]),
					{ column: 2, keep: "end" }
				);
	emit(ctx, json, { sessions: rows }, text, { scope: "perf ls", detail: plural(rows.length, "session") });
	return 0;
}

/** Wire `ls` onto `warden perf`. */
export function registerLs(cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void {
	cmd
		.command("ls")
		.description("perf sessions (newest first); --devices lists the warden devices a session could attach to")
		.option("--devices", "list candidate devices (booted, warden's) with holder and foreground app")
		.option("--device <udid>", "only this device's sessions")
		.option("--json", "machine-readable output")
		.action(async (opts) => {
			done(await perfLs(ctx, deps, opts));
		});
}
