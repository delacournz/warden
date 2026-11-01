import type { LatLon, LocationCondition } from "@delacour/warden-config/conditions.types";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { gpxParser } from "./gpx";
import { ANDROID_SCENARIOS } from "./location-scenarios.data";
import { DEFAULT_INTERVAL_S, DEFAULT_SPEED_MPS } from "./route-ticker";

export type ReadText = (path: string) => Promise<string>;

export type RoutePlan = { points: readonly LatLon[]; speedMps: number; intervalS: number; loop: boolean };

/** Turns the moving location ops into waypoints. Use the shared {@link locationPlanner} singleton. */
export class LocationPlanner {
	async loadGpxPoints(path: string, readText: ReadText): Promise<Result<LatLon[]>> {
		let xml: string;
		try {
			xml = await readText(path);
		} catch (error) {
			return resultFactory.err(`cannot read GPX ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const parsed = gpxParser.parse(xml);
		return parsed.success ? parsed : resultFactory.err(`${path}: ${parsed.error}`);
	}

	/**
	 * Everything a ticker needs for the moving location ops (`route`, `gpx`, `scenario`): waypoints, pace,
	 * loop. Used where the platform has no player of its own (Android); iOS hands the waypoints to simctl.
	 */
	async planRoute(
		op: Extract<LocationCondition, { kind: "route" | "gpx" | "scenario" }>,
		readText: ReadText
	): Promise<Result<RoutePlan>> {
		if (op.kind === "scenario") {
			const s = ANDROID_SCENARIOS[op.name];
			return resultFactory.ok({ points: s.points, speedMps: s.speedMps, intervalS: DEFAULT_INTERVAL_S, loop: s.loop });
		}
		let points: readonly LatLon[];
		if (op.kind === "gpx") {
			const loaded = await this.loadGpxPoints(op.path, readText);
			if (!loaded.success) return loaded;
			points = loaded.data;
		} else {
			points = op.points;
		}
		if (points.length === 0) return resultFactory.err("a route needs at least one point");
		return resultFactory.ok({
			points,
			speedMps: op.speedMps ?? DEFAULT_SPEED_MPS,
			intervalS: (op.kind === "route" ? op.intervalS : undefined) ?? DEFAULT_INTERVAL_S,
			loop: op.kind === "route" ? (op.loop ?? false) : false,
		});
	}
}

export const locationPlanner = new LocationPlanner();
