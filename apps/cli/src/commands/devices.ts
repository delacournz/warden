import { markWardenDevices } from "@delacour/warden-core/inventory";
import { isLeaseAlive, processAlive } from "@delacour/warden-core/liveness";
import { listAvds } from "@delacour/warden-core/providers/android";
import { describeOwner, type Lease, ownerLocation, type Platform } from "@delacour/warden-core/types";
import type { ChalkInstance } from "chalk";
import { resolveOwner } from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, formatTable } from "../output";
import { providerFor } from "../providers";

const PLATFORMS: readonly Platform[] = ["ios", "android"];

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
		ctx.err(ctx.ui.color.yellow(`${platform}: skipped (${inventory.error})`));
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
		else ctx.err(ctx.ui.color.yellow(`android avds: skipped (${avds.error})`));
	}
	return rows;
}

const STATE_ORDER: Record<DeviceRow["state"], number> = { booted: 0, booting: 1, shutdown: 2, avd: 3 };

function compareRows(a: DeviceRow, b: DeviceRow): number {
	return (
		a.platform.localeCompare(b.platform) || STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name)
	);
}

function stateCell(color: ChalkInstance, state: DeviceRow["state"]): string {
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

/** List every simulator / emulator on the machine, running or not, with warden ownership and leases. */
async function devices(ctx: CommandContext, filter: string | undefined, json: boolean): Promise<number> {
	const { color } = ctx.ui;
	if (filter !== undefined && filter !== "ios" && filter !== "android") {
		ctx.err(color.red(`warden devices: unknown platform "${filter}" (ios|android)`));
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

	const none = color.dim("-");
	const table = formatTable(
		["PLATFORM", "NAME", "ID", "STATE", "RUNTIME", "WARDEN", "LEASED BY"],
		rows.map((r) => [
			r.platform,
			r.warden || r.golden ? color.bold(r.name) : r.name,
			r.id ?? none,
			stateCell(color, r.state),
			r.runtime ?? none,
			wardenCell(color, r, none),
			r.lease ? `${r.lease.owner}${r.lease.where ? color.dim(` (${r.lease.where})`) : ""}` : none,
		]),
		color
	);
	emit(ctx, json, rows, rows.length > 0 ? table : color.dim("no devices"));
	return 0;
}

export const devicesCommand = defineCommand({
	name: "devices",
	aliases: ["list"],
	summary: "list every simulator / emulator (booted or not, plus Android AVDs) with warden ownership + leases",
	register: (cmd, ctx, done) => {
		cmd
			.argument("[platform]", "ios | android (default: both)")
			.option("--json", "machine-readable output")
			.action(async (platform, opts) => done(await devices(ctx, platform, opts.json === true)));
	},
});
