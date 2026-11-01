import { SimMeasure, type SimMeasurement } from "@delacour/warden-core/sims/slim.measure";
import { simctlParser } from "@delacour/warden-providers/ios";
import { wardenErrors } from "@delacour/warden-types/error";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import type { Register } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";

const BYTES_PER_MB = 1024 ** 2;
const TOP_COUNT = 10;

type MeasureOpts = { booted?: true; json?: true };

type MeasureReport = { udid: string; error: string } | (SimMeasurement & { footprintMb: number });

export class SimMeasureCommands {
	toMb(bytes: number): number {
		return Math.round(bytes / BYTES_PER_MB);
	}

	/** Booted iOS simulators (`xcrun simctl list devices booted -j`). */
	private async bootedUdids(ctx: CommandContext): AsyncResult<string[]> {
		const res = await ctx.exec(["xcrun", "simctl", "list", "devices", "booted", "-j"]);
		if (res.exitCode !== 0)
			return resultFactory.err(`simctl list devices: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
		const devices = simctlParser.parseDevices(res.stdout);
		if (!devices.success) return wardenErrors.toText(devices);
		return resultFactory.ok(devices.data.filter((d) => d.state === "booted").map((d) => d.id));
	}

	private describe(m: SimMeasurement): string {
		const lines = m.top
			.slice(0, TOP_COUNT)
			.map((p) => `  ${String(this.toMb(p.bytes)).padStart(6)} MB  ${p.command} (${p.pid})`);
		return [`${m.udid}: ${m.processes} procs, ${this.toMb(m.footprintBytes)} MB`, ...lines].join("\n");
	}

	/** `warden sim measure <udid>|--booted [--json]`: real footprint (summed phys_footprint under launchd_sim) per simulator. */
	private async measure(ctx: CommandContext, udid: string | undefined, opts: MeasureOpts): Promise<number> {
		const fail = (message: string) => {
			output.reportError(ctx, "sim measure", message);
			return 1;
		};
		if ((udid === undefined) === (opts.booted !== true)) return fail("pass <udid> or --booted");
		const targets = udid === undefined ? await this.bootedUdids(ctx) : resultFactory.ok([udid]);
		if (!targets.success) return fail(targets.error);
		if (targets.data.length === 0) return fail("no booted simulator");
		const results = await new SimMeasure(ctx.exec).sims(targets.data);
		const reports: MeasureReport[] = targets.data.map((id) => {
			const res = results.get(id);
			if (res?.success) return { ...res.data, footprintMb: this.toMb(res.data.footprintBytes) };
			return { udid: id, error: res?.error ?? `${id}: not measured` };
		});
		const text = reports.map((r) => ("error" in r ? r.error : this.describe(r))).join("\n\n");
		output.emit(ctx, opts.json === true, reports, text);
		return reports.every((r) => !("error" in r)) ? 0 : 1;
	}

	/** Adds `measure` to the `sim` command. */
	readonly registerSimMeasure: Register = (cmd, ctx, done) => {
		cmd
			.command("measure")
			.description(
				"real memory cost of a booted simulator: summed phys_footprint of its process tree, top 10 processes"
			)
			.argument("[udid]", "simulator udid")
			.option("--booted", "every booted simulator")
			.option("--json", "machine-readable output")
			.action(async (udid, o) => done(await this.measure(ctx, udid, o)));
	};
}

export const simMeasure = new SimMeasureCommands();
