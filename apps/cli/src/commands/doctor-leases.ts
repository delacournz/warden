import {
	applyLeaseFixes,
	describeFinding,
	diagnoseLeases,
	findingFixable,
	findingSeverity,
	type LeaseFinding,
} from "@delacour/warden-core/lease-doctor";
import { type PidAlive, processAlive } from "@delacour/warden-core/liveness";
import { type MarkerFs, realMarkerFs } from "@delacour/warden-core/ownership";
import type { InventoryDevice, Platform } from "@delacour/warden-core/types";
import type { AsyncResult } from "@delacour/warden-types/result";
import { resolveOwner } from "../claim-flags";
import type { CommandContext } from "../context";
import { emit, plural } from "../output";
import { providerFor } from "../providers";
import { SYMBOLS } from "../ui";

/** Outside world for `warden doctor --leases`, injectable for tests. */
export type LeaseDoctorDeps = {
	/** the provider's inventory for a platform (an error skips that platform's checks) */
	inventory: (platform: Platform, ctx: CommandContext) => AsyncResult<InventoryDevice[]>;
	pidAlive: PidAlive;
	markerFs: MarkerFs;
};

export const realLeaseDoctorDeps = (): LeaseDoctorDeps => ({
	inventory: (platform, ctx) => providerFor(platform, ctx, resolveOwner(ctx)).inventory(),
	pidAlive: processAlive,
	markerFs: realMarkerFs,
});

const PLATFORMS: readonly Platform[] = ["ios", "android"];

type Row = LeaseFinding & { severity: "drift" | "info"; fixable: boolean; message: string; fixed: boolean };

/**
 * `warden doctor --leases [--fix]`: drift between the registry and the machine (see `lease-doctor.ts`). Exit 0
 * when no drift is left, 1 when drift remains (info findings never fail the run). `--fix` deletes registry rows
 * only: it never shuts down, erases or deletes a device and never touches a leased or foreign one.
 */
export async function doctorLeases(
	ctx: CommandContext,
	deps: LeaseDoctorDeps,
	opts: { json: boolean; fix: boolean }
): Promise<number> {
	const store = ctx.store();
	const inventories: Partial<Record<Platform, InventoryDevice[]>> = {};
	const skipped: string[] = [];
	await Promise.all(
		PLATFORMS.map(async (platform) => {
			const read = await deps.inventory(platform, ctx);
			if (read.success) inventories[platform] = read.data;
			else skipped.push(`${platform}: inventory unavailable (${read.error}) — its device checks were skipped`);
		})
	);
	const now = ctx.now();
	const found = diagnoseLeases({
		store,
		now,
		pidAlive: deps.pidAlive,
		inventories,
		env: ctx.env,
		markerFs: deps.markerFs,
	});
	const outcome = opts.fix ? applyLeaseFixes(store, found, now, deps.pidAlive) : { fixed: [], unfixed: found };
	const fixedSet = new Set<LeaseFinding>(outcome.fixed);
	const rows: Row[] = found.map((f) => ({
		...f,
		severity: findingSeverity(f),
		fixable: findingFixable(f),
		message: describeFinding(f),
		fixed: fixedSet.has(f),
	}));
	const drift = rows.filter((r) => r.severity === "drift" && !r.fixed);
	const ok = drift.length === 0;
	const { color } = ctx.ui;
	const line = (r: Row): string => {
		const glyph = r.fixed
			? color.green(SYMBOLS.ok)
			: r.severity === "drift"
				? color.red(SYMBOLS.fail)
				: color.yellow(SYMBOLS.warn);
		const tail = r.fixed ? color.dim(" (fixed)") : r.fixable ? color.dim(" (fixable: --fix)") : "";
		return `${glyph} ${r.message}${tail}`;
	};
	const text = [
		...(rows.length === 0 ? [`${color.green(SYMBOLS.ok)} no lease drift`] : rows.map(line)),
		...skipped.map((s) => color.yellow(`${SYMBOLS.warn} ${s}`)),
	].join("\n");
	const detail = `${plural(rows.length, "finding")}${opts.fix ? ` · ${outcome.fixed.length} fixed` : ""}`;
	emit(ctx, opts.json, { ok, findings: rows, fixed: outcome.fixed.length, skipped }, text, {
		scope: "doctor --leases",
		detail,
	});
	return ok ? 0 : 1;
}
