import { markWardenDevices } from "@delacour/warden-core/inventory";
import { isLeaseAlive, processAlive } from "@delacour/warden-core/liveness";
import { listAvds } from "@delacour/warden-core/providers/android";
import { measureSims } from "@delacour/warden-core/sims/slim.measure";
import { describeOwner, type Lease, ownerLocation, type Platform } from "@delacour/warden-core/types";
import type { ChalkInstance } from "chalk";
import { resolveOwner } from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, plural, reportError, table, warn } from "../output";
import { providerFor } from "../providers";

const PLATFORMS: readonly Platform[] = ["ios", "android"];
const BYTES_PER_MB = 1024 ** 2;

export type DeviceRow = {
	platform: Platform;
	name: string;
	/** udid / serial; absent for an Android AVD that isn't running */
	id?: string;
	state: "booted" | "booting" | "shutdown" | "avd";
	runtime?: string;
	warden: boolean;
	/** a golden image new sims are cloned from */
	golden?: true;
	/** reported bad — claims skip it until `warden sim unquarantine` */
	quarantined?: { reason?: string };
	/** simulator daemons switched off by `sim slim` */
	slimmed?: true;
	/** real memory (summed phys_footprint of the sim's process tree), only with `--mem` */
	footprintMb?: number;
	lease?: { id: string; owner: string; where?: string };
};

function leaseInfo(lease: Lease): NonNullable<DeviceRow["lease"]> {
	const where = ownerLocation(lease.owner);
	return { id: lease.id, owner: describeOwner(lease.owner), ...(where ? { where } : {}) };
}

/** One platform's rows: every device (booted or not) plus, for Android, every AVD. */
async function platformRows(ctx: CommandContext, platform: Platform, leases: Map<string, Lease>): Promise<DeviceRow[]> {
	const store = ctx.store();
	const inventory = await providerFor(platform, ctx, resolveOwner(ctx)).inventory();
	if (!inventory.success) {
		warn(ctx, `${platform}: skipped (${inventory.error})`);
		return [];
	}
	const records = new Map(store.listDevices(platform).map((r) => [r.id, r]));
	const rows: DeviceRow[] = markWardenDevices(inventory.data, [...records.values()]).map((d) => {
		const lease = leases.get(`${platform}:${d.id}`);
		const record = records.get(d.id);
		return {
			platform,
			name: d.name,
			id: d.id,
			state: d.state,
			...(d.runtime !== undefined ? { runtime: d.runtime } : {}),
			warden: d.wardenCreated,
			...(d.golden ? { golden: true as const } : {}),
			...(record?.quarantinedAt !== undefined
				? { quarantined: record.quarantineReason !== undefined ? { reason: record.quarantineReason } : {} }
				: {}),
			...(record?.slimmedAt !== undefined ? { slimmed: true as const } : {}),
			...(lease ? { lease: leaseInfo(lease) } : {}),
		};
	});
	if (platform === "android") {
		const avds = await listAvds({ exec: ctx.exec, env: ctx.env });
		if (avds.success)
			rows.push(...avds.data.map((name): DeviceRow => ({ platform, name, state: "avd", warden: false })));
		else warn(ctx, `android avds: skipped (${avds.error})`);
	}
	return rows;
}

const STATE_ORDER: Record<DeviceRow["state"], number> = { booted: 0, booting: 1, shutdown: 2, avd: 3 };

function compareRows(a: DeviceRow, b: DeviceRow): number {
	return (
		a.platform.localeCompare(b.platform) || STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name)
	);
}

/** `booted` / `shutdown` …, or `leased · <owner>` (cyan, like a running job in the batch grid) when someone holds it. */
function stateCell(color: ChalkInstance, r: DeviceRow): string {
	if (r.lease) return `${color.cyan("leased")} ${color.dim(`· ${r.lease.owner}`)}`;
	const { state } = r;
	if (state === "booted") return color.green(state);
	if (state === "booting") return color.yellow(state);
	return color.dim(state);
}

function wardenCell(color: ChalkInstance, r: DeviceRow, none: string): string {
	if (r.golden) return color.yellow("golden");
	if (!r.warden) return none;
	const flags = [r.quarantined ? color.red("quarantined") : "", r.slimmed ? color.dim("slim") : ""].filter(Boolean);
	return [color.green("yes"), ...flags].join(" ");
}

/** One `ps` + `top` snapshot for every booted iOS sim, written onto its row as `footprintMb`. */
async function addFootprints(ctx: CommandContext, rows: DeviceRow[]): Promise<void> {
	const booted = rows.filter((r) => r.platform === "ios" && r.state === "booted" && r.id !== undefined);
	const results = await measureSims(
		ctx.exec,
		booted.flatMap((r) => (r.id !== undefined ? [r.id] : []))
	);
	for (const row of booted) {
		const res = row.id !== undefined ? results.get(row.id) : undefined;
		if (res?.success) row.footprintMb = Math.round(res.data.footprintBytes / BYTES_PER_MB);
		else if (res) warn(ctx, `${row.id}: ${res.error}`);
	}
}

/** List every simulator / emulator on the machine, running or not, with warden ownership and leases. */
async function devices(
	ctx: CommandContext,
	filter: string | undefined,
	opts: { json: boolean; mem: boolean }
): Promise<number> {
	const { json, mem } = opts;
	const { color } = ctx.ui;
	if (filter !== undefined && filter !== "ios" && filter !== "android") {
		reportError(ctx, "devices", `unknown platform "${filter}" (ios|android)`);
		return 1;
	}
	const now = ctx.now();
	const leases = new Map<string, Lease>();
	for (const lease of ctx.store().listLeases()) {
		if (lease.resource.kind === "device" && isLeaseAlive(lease, now, processAlive)) {
			leases.set(`${lease.resource.platform}:${lease.resource.id}`, lease);
		}
	}
	const platforms: readonly Platform[] = filter ? [filter] : PLATFORMS;
	const rows: DeviceRow[] = [];
	for (const platform of platforms) rows.push(...(await platformRows(ctx, platform, leases)));
	rows.sort(compareRows);
	if (mem) await addFootprints(ctx, rows);

	const none = color.dim("-");
	const text = table(
		ctx,
		["PLATFORM", "NAME", "ID", "STATE", "RUNTIME", "WARDEN", ...(mem ? ["MB"] : [])],
		rows.map((r) => [
			color.dim(r.platform),
			r.warden || r.golden ? color.bold(r.name) : r.name,
			r.id ?? none,
			stateCell(color, r),
			r.runtime ?? none,
			wardenCell(color, r, none),
			...(mem ? [r.footprintMb !== undefined ? String(r.footprintMb) : none] : []),
		]),
		[
			{ column: 1, min: 18 },
			{ column: 2, min: 9 },
		]
	);
	const booted = rows.filter((r) => r.state === "booted").length;
	const leased = rows.filter((r) => r.lease).length;
	emit(ctx, json, rows, rows.length > 0 ? text : color.dim("no devices"), {
		scope: "devices",
		detail: `${plural(rows.length, "device")} · ${booted} booted · ${leased} leased`,
	});
	return 0;
}

export const devicesCommand = defineCommand({
	name: "devices",
	group: "Devices",
	aliases: ["list"],
	summary: "list every simulator / emulator (booted or not, plus Android AVDs) with warden ownership + leases",
	register: (cmd, ctx, done) => {
		cmd
			.argument("[platform]", "ios | android (default: both)")
			.option("--mem", "add each booted iOS sim's real memory (summed phys_footprint, MB)")
			.option("--json", "machine-readable output")
			.action(async (platform, opts) =>
				done(await devices(ctx, platform, { json: opts.json === true, mem: opts.mem === true }))
			);
	},
});
