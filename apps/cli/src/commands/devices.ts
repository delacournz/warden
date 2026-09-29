import { parseArgs } from "node:util";
import { markWardenDevices } from "@warden/core/inventory";
import { isLeaseAlive, processAlive } from "@warden/core/liveness";
import { listAvds } from "@warden/core/providers/android";
import { describeOwner, type Lease, ownerLocation, type Platform } from "@warden/core/types";
import { resolveOwner } from "../claim-flags";
import type { Command, CommandContext } from "../context";
import { emit, formatTable } from "../output";
import { providerFor } from "../providers";

const USAGE = "warden devices [ios|android] [--json]   (alias: warden list)";
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
		ctx.err(`${platform}: skipped (${inventory.error})`);
		return [];
	}
	const rows: DeviceRow[] = markWardenDevices(inventory.data, store.listDevices(platform)).map((d) => {
		const lease = leases.get(`${platform}:${d.id}`);
		return {
			platform,
			name: d.name,
			id: d.id,
			state: d.state,
			...(d.runtime !== undefined ? { runtime: d.runtime } : {}),
			warden: d.wardenCreated,
			...(d.golden ? { golden: true as const } : {}),
			...(lease ? { lease: leaseInfo(lease) } : {}),
		};
	});
	if (platform === "android") {
		const avds = await listAvds({ exec: ctx.exec, env: ctx.env });
		if (avds.success)
			rows.push(...avds.data.map((name): DeviceRow => ({ platform, name, state: "avd", warden: false })));
		else ctx.err(`android avds: skipped (${avds.error})`);
	}
	return rows;
}

const STATE_ORDER: Record<DeviceRow["state"], number> = { booted: 0, booting: 1, shutdown: 2, avd: 3 };

function compareRows(a: DeviceRow, b: DeviceRow): number {
	return (
		a.platform.localeCompare(b.platform) || STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name)
	);
}

/** List every simulator / emulator on the machine, running or not, with warden ownership and leases. */
async function run(ctx: CommandContext): Promise<number> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(ctx.argv);
	} catch (error) {
		ctx.err(`warden devices: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
		return 1;
	}
	const filter = parsed.positionals[0];
	if (filter !== undefined && filter !== "ios" && filter !== "android") {
		ctx.err(`warden devices: unknown platform "${filter}"\n${USAGE}`);
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

	const table = formatTable(
		["PLATFORM", "NAME", "ID", "STATE", "RUNTIME", "WARDEN", "LEASED BY"],
		rows.map((r) => [
			r.platform,
			r.name,
			r.id ?? "-",
			r.state,
			r.runtime ?? "-",
			r.golden ? "golden" : r.warden ? "yes" : "-",
			r.lease ? `${r.lease.owner}${r.lease.where ? ` (${r.lease.where})` : ""}` : "-",
		])
	);
	emit(ctx, parsed.values.json === true, rows, rows.length > 0 ? table : "no devices");
	return 0;
}

function parse(argv: string[]) {
	return parseArgs({ args: argv, options: { json: { type: "boolean" } }, allowPositionals: true, strict: true });
}

export const devicesCommand: Command = {
	name: "devices",
	aliases: ["list"],
	summary: "list every simulator / emulator (booted or not, plus Android AVDs) with warden ownership + leases",
	usage: USAGE,
	run,
};
