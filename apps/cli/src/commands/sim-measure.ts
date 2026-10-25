import { parseSimctlDevices } from "@delacour/warden-core/providers/ios";
import { measureSims, type SimMeasurement } from "@delacour/warden-core/sims/slim.measure";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Register } from "../command";
import type { CommandContext } from "../context";
import { emit, reportError } from "../output";

const BYTES_PER_MB = 1024 ** 2;
const TOP_COUNT = 10;

type MeasureOpts = { booted?: true; json?: true };

export const toMb = (bytes: number): number => Math.round(bytes / BYTES_PER_MB);

/** Booted iOS simulators (`xcrun simctl list devices booted -j`). */
async function bootedUdids(ctx: CommandContext): AsyncResult<string[]> {
	const res = await ctx.exec(["xcrun", "simctl", "list", "devices", "booted", "-j"]);
	if (res.exitCode !== 0) return err(`simctl list devices: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
	const devices = parseSimctlDevices(res.stdout);
	if (!devices.success) return devices;
	return ok(devices.data.filter((d) => d.state === "booted").map((d) => d.id));
}

type MeasureReport = { udid: string; error: string } | (SimMeasurement & { footprintMb: number });

function describe(m: SimMeasurement): string {
	const lines = m.top
		.slice(0, TOP_COUNT)
		.map((p) => `  ${String(toMb(p.bytes)).padStart(6)} MB  ${p.command} (${p.pid})`);
	return [`${m.udid}: ${m.processes} procs, ${toMb(m.footprintBytes)} MB`, ...lines].join("\n");
}

/** `warden sim measure <udid>|--booted [--json]`: real footprint (summed phys_footprint under launchd_sim) per simulator. */
async function measure(ctx: CommandContext, udid: string | undefined, opts: MeasureOpts): Promise<number> {
	const fail = (message: string) => {
		reportError(ctx, "sim measure", message);
		return 1;
	};
	if ((udid === undefined) === (opts.booted !== true)) return fail("pass <udid> or --booted");
	const targets = udid === undefined ? await bootedUdids(ctx) : ok([udid]);
	if (!targets.success) return fail(targets.error);
	if (targets.data.length === 0) return fail("no booted simulator");
	const results = await measureSims(ctx.exec, targets.data);
	const reports: MeasureReport[] = targets.data.map((id) => {
		const res = results.get(id);
		if (res?.success) return { ...res.data, footprintMb: toMb(res.data.footprintBytes) };
		return { udid: id, error: res?.error ?? `${id}: not measured` };
	});
	const text = reports.map((r) => ("error" in r ? r.error : describe(r))).join("\n\n");
	emit(ctx, opts.json === true, reports, text);
	return reports.every((r) => !("error" in r)) ? 0 : 1;
}

/** Adds `measure` to the `sim` command. */
export const registerSimMeasure: Register = (cmd, ctx, done) => {
	cmd
		.command("measure")
		.description("real memory cost of a booted simulator: summed phys_footprint of its process tree, top 10 processes")
		.argument("[udid]", "simulator udid")
		.option("--booted", "every booted simulator")
		.option("--json", "machine-readable output")
		.action(async (udid, o) => done(await measure(ctx, udid, o)));
};
