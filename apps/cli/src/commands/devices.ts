import { providerFor } from "@delacour/warden-core/host-deps";
import { measureSims } from "@delacour/warden-core/sims/slim.measure";
import { inventoryMarker } from "@delacour/warden-leasing/inventory";
import { ownerResolver } from "@delacour/warden-leasing/owner";
import { Adb } from "@delacour/warden-providers/android";
import type { DeviceRowJson } from "@delacour/warden-sdk/contracts/devices";
import { aliveDeviceLeases } from "@delacour/warden-sdk/lease-view";
import { liveness } from "@delacour/warden-store/liveness";
import { type InventoryDevice, type Lease, leaseModel, type Platform } from "@delacour/warden-store/types";
import type { ChalkInstance } from "chalk";
import { defineCommand } from "../command";
import { appHostFromContext, type CommandContext } from "../context";
import { emit, plural, reportError, table, warn } from "../output";

const PLATFORMS: readonly Platform[] = ["ios", "android"];
const BYTES_PER_MB = 1024 ** 2;

export type DeviceRow = DeviceRowJson;

function leaseInfo(lease: Lease): NonNullable<DeviceRow["lease"]> {
	const where = leaseModel.ownerLocation(lease.owner);
	return { id: lease.id, owner: leaseModel.describeOwner(lease.owner), ...(where ? { where } : {}) };
}

/** A phone whose reachability probe answered `passcodeRequired`: reachable, but `warden ui` reports `device_locked` until it is unlocked. */
function lockedHint(d: InventoryDevice): string | undefined {
	return d.physical?.platform === "ios" && d.physical.locked === true
		? "locked: unlock the phone to drive it"
		: undefined;
}

/** One platform's rows: every device (booted or not) plus, for Android, every AVD. */
async function platformRows(ctx: CommandContext, platform: Platform, leases: Map<string, Lease>): Promise<DeviceRow[]> {
	const store = ctx.store();
	const inventory = await providerFor(platform, appHostFromContext(ctx), ownerResolver.resolve(ctx), {
		physical: true,
	}).inventory();
	if (!inventory.success) {
		warn(ctx, `${platform}: skipped (${inventory.error.message})`);
		return [];
	}
	const records = new Map(store.listDevices(platform).map((r) => [r.id, r]));
	const rows: DeviceRow[] = inventoryMarker.mark(inventory.data, [...records.values()]).map((d) => {
		const lease = leases.get(`${platform}:${d.id}`);
		const record = records.get(d.id);
		const hint = leaseModel.physicalNotReadyReason(d) ?? lockedHint(d);
		return {
			platform,
			kind: d.physical ? ("physical" as const) : ("virtual" as const),
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
			...(d.physical ? { physical: true as const, transport: d.physical.transport } : {}),
			...(hint !== undefined ? { hint } : {}),
			...(lease ? { lease: leaseInfo(lease) } : {}),
		};
	});
	if (platform === "android") {
		const avds = await new Adb({ exec: ctx.exec, env: ctx.env }).listAvds();
		if (avds.success)
			rows.push(
				...avds.data.map((name): DeviceRow => ({ platform, kind: "virtual", name, state: "avd", warden: false }))
			);
		else warn(ctx, `android avds: skipped (${avds.error.message})`);
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
	if (r.hint !== undefined) return color.yellow(r.hint.split(":")[0] ?? "unavailable");
	const { state } = r;
	if (state === "booted") return color.green(state);
	if (state === "booting") return color.yellow(state);
	return color.dim(state);
}

function wardenCell(color: ChalkInstance, r: DeviceRow, none: string): string {
	if (r.golden) return color.yellow("golden");
	if (r.physical) return none;
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
	opts: { json: boolean; mem: boolean; physical: boolean }
): Promise<number> {
	const { json, mem, physical } = opts;
	const { color } = ctx.ui;
	if (filter !== undefined && filter !== "ios" && filter !== "android") {
		reportError(ctx, "devices", `unknown platform "${filter}" (ios|android)`);
		return 1;
	}
	const now = ctx.now();
	const leases = aliveDeviceLeases(ctx.store().listLeases(), now, liveness.processAlive);
	const platforms: readonly Platform[] = filter ? [filter] : PLATFORMS;
	const all: DeviceRow[] = [];
	for (const platform of platforms) all.push(...(await platformRows(ctx, platform, leases)));
	const rows = physical ? all.filter((r) => r.kind === "physical") : all;
	rows.sort(compareRows);
	if (mem) await addFootprints(ctx, rows);

	const none = color.dim("-");
	const text = table(
		ctx,
		["PLATFORM", "KIND", "NAME", "ID", "STATE", "RUNTIME", "WARDEN", ...(mem ? ["MB"] : [])],
		rows.map((r) => [
			color.dim(r.platform),
			r.kind === "physical" ? color.magenta(r.kind) : color.dim(r.kind),
			r.warden || r.golden ? color.bold(r.name) : r.name,
			r.id ?? none,
			stateCell(color, r),
			r.runtime ?? none,
			wardenCell(color, r, none),
			...(mem ? [r.footprintMb !== undefined ? String(r.footprintMb) : none] : []),
		]),
		[
			{ column: 2, min: 18 },
			{ column: 3, min: 9 },
		]
	);
	const booted = rows.filter((r) => r.state === "booted").length;
	const leased = rows.filter((r) => r.lease).length;
	const hints = rows
		.filter((r) => r.hint !== undefined)
		.map((r) => color.yellow(`${r.name} (${r.id ?? "?"}): ${r.hint}`));
	const body = rows.length > 0 ? [text, ...hints].join("\n") : color.dim("no devices");
	emit(ctx, json, rows, body, {
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
			.option("--physical", "only real phones and tablets (with why an unusable one is skipped)")
			.option("--json", "machine-readable output")
			.action(async (platform, opts) =>
				done(
					await devices(ctx, platform, {
						json: opts.json === true,
						mem: opts.mem === true,
						physical: opts.physical === true,
					})
				)
			);
	},
});
