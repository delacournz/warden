import { parseSimctlDevices } from "@delacour/warden-core/providers/ios";
import { slimSimulator } from "@delacour/warden-core/sims/slim";
import { describeOwner, sameOwner } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { resolveOwner } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit } from "../output";

type SlimOpts = { booted?: true; dryRun?: true; restore?: true; json?: true };

type SlimReport = { udid: string; labels?: string[]; error?: string };

/** Booted iOS simulators (`xcrun simctl list devices booted -j`). */
async function bootedUdids(ctx: CommandContext): AsyncResult<string[]> {
	const res = await ctx.exec(["xcrun", "simctl", "list", "devices", "booted", "-j"]);
	if (res.exitCode !== 0) return err(`simctl list devices: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
	const devices = parseSimctlDevices(res.stdout);
	if (!devices.success) return devices;
	return ok(devices.data.filter((d) => d.state === "booted").map((d) => d.id));
}

/** Why `udid` is off limits: another session holds its lease (undefined = fine). */
function heldByOther(ctx: CommandContext, udid: string): string | undefined {
	const lease = ctx.store().findLeaseByResource({ kind: "device", platform: "ios", id: udid, name: "" });
	if (!lease || sameOwner(lease.owner, resolveOwner(ctx))) return undefined;
	return `${udid} is leased by ${describeOwner(lease.owner)}`;
}

/** One simulator: refuse when another session holds it, else slim (or restore / plan) it. */
async function slimOne(ctx: CommandContext, udid: string, opts: SlimOpts): Promise<SlimReport> {
	const blocked = heldByOther(ctx, udid);
	if (blocked) return { udid, error: blocked };
	const res = await slimSimulator(ctx.exec, udid, {
		...(opts.dryRun ? { dryRun: true } : {}),
		...(opts.restore ? { restore: true } : {}),
	});
	return res.success ? { udid, labels: res.data } : { udid, error: res.error };
}

function describeReport(report: SlimReport, opts: SlimOpts): string {
	if (report.error !== undefined) return `${report.udid}: ${report.error}`;
	const labels = report.labels ?? [];
	const verb = opts.restore ? "re-enable" : "disable";
	if (opts.dryRun)
		return `${report.udid}: would ${verb} ${labels.length} job(s)${labels.map((l) => `\n  ${l}`).join("")}`;
	return `${report.udid}: ${opts.restore ? "re-enabled" : "disabled"} ${labels.length} job(s)`;
}

/** `warden sim slim <udid>|--booted [--dry-run] [--restore]`: switch off the simulator daemons flows never use. */
async function slim(ctx: CommandContext, udid: string | undefined, opts: SlimOpts): Promise<number> {
	const { color } = ctx.ui;
	const fail = (message: string) => {
		ctx.err(color.red(`warden sim slim: ${message}`));
		return 1;
	};
	if ((udid === undefined) === (opts.booted !== true)) return fail("pass <udid> or --booted");
	const targets = udid === undefined ? await bootedUdids(ctx) : ok([udid]);
	if (!targets.success) return fail(targets.error);
	if (targets.data.length === 0) return fail("no booted simulator");
	const reports: SlimReport[] = [];
	for (const target of targets.data) {
		const report = await slimOne(ctx, target, opts);
		reports.push(report);
		const line = describeReport(report, opts);
		ctx.err(report.error === undefined ? line : color.red(line));
	}
	if (opts.json) emit(ctx, true, reports, "");
	return reports.every((r) => r.error === undefined) ? 0 : 1;
}

export function createSimCommand(): Command {
	return defineCommand({
		name: "sim",
		summary: "per-simulator tweaks: slim",
		register: (cmd, ctx, done) => {
			cmd
				.command("slim")
				.description(
					"switch off the iOS simulator daemons UI flows never need (Siri, Health, News, Mail…) to save RAM/CPU"
				)
				.argument("[udid]", "simulator udid (booted, not leased by another session)")
				.option("--booted", "every booted simulator")
				.option("--dry-run", "list the jobs, change nothing")
				.option("--restore", "re-enable them (fully effective on the next boot)")
				.option("--json", "machine-readable output")
				.action(async (udid, o) => done(await slim(ctx, udid, o)));
		},
	});
}

export const simCommand: Command = createSimCommand();
