import type { LatLon, LocationCondition } from "@delacour/warden-core/conditions/conditions.types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { parseGpx } from "./gpx";
import { ANDROID_SCENARIOS } from "./location-scenarios.data";
import { DEFAULT_INTERVAL_S, DEFAULT_SPEED_MPS } from "./route-ticker";

export type ReadText = (path: string) => Promise<string>;

export type RoutePlan = { points: readonly LatLon[]; speedMps: number; intervalS: number; loop: boolean };

export async function loadGpxPoints(path: string, readText: ReadText): Promise<Result<LatLon[]>> {
	let xml: string;
	try {
		xml = await readText(path);
	} catch (error) {
		return err(`cannot read GPX ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const parsed = parseGpx(xml);
	return parsed.success ? parsed : err(`${path}: ${parsed.error}`);
}

/**
 * Everything a ticker needs for the moving location ops (`route`, `gpx`, `scenario`): waypoints, pace,
 * loop. Used where the platform has no player of its own (Android); iOS hands the waypoints to simctl.
 */
export async function planRoute(
	op: Extract<LocationCondition, { kind: "route" | "gpx" | "scenario" }>,
	readText: ReadText
): Promise<Result<RoutePlan>> {
	if (op.kind === "scenario") {
		const s = ANDROID_SCENARIOS[op.name];
		return ok({ points: s.points, speedMps: s.speedMps, intervalS: DEFAULT_INTERVAL_S, loop: s.loop });
	}
	let points: readonly LatLon[];
	if (op.kind === "gpx") {
		const loaded = await loadGpxPoints(op.path, readText);
		if (!loaded.success) return loaded;
		points = loaded.data;
	} else {
		points = op.points;
	}
	if (points.length === 0) return err("a route needs at least one point");
	return ok({
		points,
		speedMps: op.speedMps ?? DEFAULT_SPEED_MPS,
		intervalS: (op.kind === "route" ? op.intervalS : undefined) ?? DEFAULT_INTERVAL_S,
		loop: op.kind === "route" ? (op.loop ?? false) : false,
	});
}
