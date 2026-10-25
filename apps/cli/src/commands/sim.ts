import { parseSimctlDevices } from "@delacour/warden-core/providers/ios";
import { slimSimulator } from "@delacour/warden-core/sims/slim";
import {
	DEFAULT_SLIM_PROFILE,
	describeCategories,
	type SlimProfile,
	validateProfile,
} from "@delacour/warden-core/sims/slim.profile";
import { describeOwner, sameOwner } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { resolveOwner } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, reportError, success } from "../output";
import { registerSimMeasure } from "./sim-measure";

type SlimOpts = { booted?: true; dryRun?: true; restore?: true; json?: true; except?: string; keep?: string };

/** `a,b , c` → `["a","b","c"]`; undefined → none. */
const splitList = (value: string | undefined): string[] =>
	(value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");

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
async function slimOne(ctx: CommandContext, udid: string, opts: SlimOpts, profile: SlimProfile): Promise<SlimReport> {
	const blocked = heldByOther(ctx, udid);
	if (blocked) return { udid, error: blocked };
	const res = await slimSimulator(ctx.exec, udid, {
		...(opts.dryRun ? { dryRun: true } : {}),
		...(opts.restore ? { restore: true } : {}),
		profile,
	});
	if (!res.success) return { udid, error: res.error };
	if (!opts.dryRun) ctx.store().setSlimmed("ios", udid, opts.restore ? undefined : ctx.now());
	return { udid, labels: res.data };
}

function describeReport(report: SlimReport, opts: SlimOpts): string {
	if (report.error !== undefined) return `${report.udid}: ${report.error}`;
	const labels = report.labels ?? [];
	const verb = opts.restore ? "re-enable" : "disable";
	if (opts.dryRun)
		return `${report.udid}: would ${verb} ${labels.length} job(s)${labels.map((l) => `\n  ${l}`).join("")}`;
	return `${report.udid}: ${opts.restore ? "re-enabled" : "disabled"} ${labels.length} job(s)`;
}

/** `warden sim slim <udid>|--booted [--dry-run] [--restore] [--except <ids>] [--keep <labels>]`: switch off the simulator daemons specs never use. */
async function slim(ctx: CommandContext, udid: string | undefined, opts: SlimOpts): Promise<number> {
	const { color } = ctx.ui;
	const fail = (message: string) => {
		reportError(ctx, "sim slim", message);
		return 1;
	};
	if ((udid === undefined) === (opts.booted !== true)) return fail("pass <udid> or --booted");
	const profile = validateProfile({
		...DEFAULT_SLIM_PROFILE,
		except: splitList(opts.except),
		keep: splitList(opts.keep),
	});
	if (!profile.success) return fail(profile.error);
	const targets = udid === undefined ? await bootedUdids(ctx) : ok([udid]);
	if (!targets.success) return fail(targets.error);
	if (targets.data.length === 0) return fail("no booted simulator");
	const reports: SlimReport[] = [];
	for (const target of targets.data) {
		const report = await slimOne(ctx, target, opts, profile.data);
		reports.push(report);
		const line = describeReport(report, opts);
		ctx.err(report.error === undefined ? line : color.red(line));
	}
	if (opts.json) emit(ctx, true, reports, "");
	return reports.every((r) => r.error === undefined) ? 0 : 1;
}

/** `warden sim profiles [--json]`: the slim categories `--except` / `slim: { except }` take. */
function profiles(ctx: CommandContext, opts: { json?: true }): number {
	const rows = describeCategories();
	const width = Math.max(...rows.map((row) => row.id.length));
	const text = rows
		.map((row) => `${row.id.padEnd(width)}  ${String(row.labelCount).padStart(2)} labels  ${row.name}`)
		.join("\n");
	emit(ctx, opts.json === true, rows, text);
	return 0;
}

/** `warden sim unquarantine <id>`: let claims hand the device out again. */
function unquarantine(ctx: CommandContext, id: string): number {
	if (ctx.store().unquarantineDevice(id) === 0) {
		reportError(ctx, "sim unquarantine", `${id} is not quarantined`);
		return 1;
	}
	success(ctx, `${id}: quarantine cleared`);
	return 0;
}

export function createSimCommand(): Command {
	return defineCommand({
		name: "sim",
		group: "Devices",
		summary: "per-simulator tweaks: slim | profiles | measure | unquarantine",
		register: (cmd, ctx, done) => {
			cmd
				.command("slim")
				.description(
					"switch off the iOS simulator daemons UI specs never need (Siri, Health, News, Mail…) to save RAM/CPU"
				)
				.argument("[udid]", "simulator udid (booted, not leased by another session)")
				.option("--booted", "every booted simulator")
				.option("--dry-run", "list the jobs, change nothing")
				.option("--restore", "re-enable them (fully effective on the next boot)")
				.option("--except <ids>", "comma list of categories to leave running (see `warden sim profiles`)")
				.option("--keep <labels>", "comma list of single com.apple.* launchd labels to leave running")
				.option("--json", "machine-readable output")
				.action(async (udid, o) => done(await slim(ctx, udid, o)));
			cmd
				.command("profiles")
				.description("list the slim categories (id, name, label count) that `sim slim --except` takes")
				.option("--json", "machine-readable output")
				.action((o) => done(profiles(ctx, o)));
			cmd
				.command("unquarantine")
				.description("clear the quarantine on a device (set by `release --bad` or a failed claim health probe)")
				.argument("<id>", "simulator udid / emulator serial")
				.action((id) => done(unquarantine(ctx, id)));
			registerSimMeasure(cmd, ctx, done);
		},
	});
}

export const simCommand: Command = createSimCommand();
