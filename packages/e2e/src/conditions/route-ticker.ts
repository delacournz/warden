import type { LatLon } from "@delacour/warden-core/conditions/conditions.types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { routeSteps } from "./geo";

/** simctl's own default pace, so a route moves the same on both platforms. */
export const DEFAULT_SPEED_MPS = 20;
export const DEFAULT_INTERVAL_S = 1;
const MAX_CONSECUTIVE_FAILURES = 3;

export type TickerClock = {
	now(): number;
	/** resolves after `ms`, or as soon as `signal` aborts */
	sleep(ms: number, signal: AbortSignal): Promise<void>;
};

export const realTickerClock: TickerClock = {
	now: () => Date.now(),
	sleep: (ms, signal) =>
		new Promise<void>((resolve) => {
			if (signal.aborted) return resolve();
			const done = (): void => {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			signal.addEventListener("abort", done);
		}),
};

export type TickerRoute = {
	points: readonly LatLon[];
	speedMps?: number;
	intervalS?: number;
	loop?: boolean;
};

export type TickerDeps = TickerClock & {
	/** send one fix; return an error string (or throw) to count a failure, nothing when it landed */
	fix(point: LatLon): Promise<string | undefined>;
};

export type TickerOutcome =
	| { ticks: number; stopped: "finished" | "aborted" }
	| { ticks: number; stopped: "failed"; error: string };

export type RouteTicker = {
	/** idempotent; the loop exits before sending another fix */
	stop(): void;
	done: Promise<TickerOutcome>;
};

/**
 * Plays `route` as one fix per `intervalS`, paced against the clock (a slow fix shortens the next
 * sleep). Runs in this process: specs hold the handle and `stop()` it, a detached child runs the same
 * loop from `route-ticker.main.ts`. Ends when the route is done (never, with `loop`), when stopped, or
 * after {@link MAX_CONSECUTIVE_FAILURES} failed fixes in a row.
 */
export function startRouteTicker(route: TickerRoute, deps: TickerDeps): RouteTicker {
	const controller = new AbortController();
	const { signal } = controller;
	const startedAt = deps.now();
	const intervalMs = (route.intervalS ?? DEFAULT_INTERVAL_S) * 1000;
	const steps = routeSteps(route.points, route.speedMps ?? DEFAULT_SPEED_MPS, route.intervalS ?? DEFAULT_INTERVAL_S);

	function* playlist(): Generator<LatLon> {
		do yield* steps;
		while (route.loop && steps.length > 0);
	}
	const total = steps.length;
	const pace = async (done: number): Promise<boolean> => {
		if (!route.loop && done >= total) return false;
		await deps.sleep(Math.max(0, startedAt + done * intervalMs - deps.now()), signal);
		return true;
	};

	const run = async (): Promise<TickerOutcome> => {
		const count = { ticks: 0, failures: 0, index: 0 };
		let lastError = "";
		const sendOne = async (step: LatLon): Promise<boolean> => {
			const failure = await deps.fix(step).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
			if (!failure) {
				count.failures = 0;
				count.ticks++;
				return true;
			}
			lastError = failure;
			count.failures++;
			return count.failures < MAX_CONSECUTIVE_FAILURES;
		};
		for (const step of playlist()) {
			if (signal.aborted) return { ticks: count.ticks, stopped: "aborted" };
			if (!(await sendOne(step))) return { ticks: count.ticks, stopped: "failed", error: lastError };
			count.index++;
			if (!(await pace(count.index))) break;
		}
		return { ticks: count.ticks, stopped: signal.aborted ? "aborted" : "finished" };
	};

	return { stop: () => controller.abort(), done: run() };
}

/** What the detached child needs: the adb to call and the route to play. */
export type TickerConfig = TickerRoute & { adb: string; serial: string };

export function parseTickerConfig(raw: string): Result<TickerConfig> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return err("route ticker config is not JSON");
	}
	if (typeof value !== "object" || value === null) return err("route ticker config must be an object");
	const c = value as Record<string, unknown>;
	if (typeof c.adb !== "string" || typeof c.serial !== "string") return err("route ticker config needs adb and serial");
	const points = c.points;
	const valid =
		Array.isArray(points) &&
		points.length > 0 &&
		points.every((p) => typeof p?.lat === "number" && typeof p?.lon === "number");
	if (!valid) return err("route ticker config needs a non-empty points list of { lat, lon }");
	return ok(c as unknown as TickerConfig);
}

/**
 * argv that runs the ticker as its own process: `[runtime, route-ticker.main.ts, <config JSON>]`. The
 * caller spawns it detached and stores the child's pid as an `OwnedProcess` with `recordCondition`, so
 * COND-1 undo (`warden release`, gc) kills it.
 */
export function detachedTickerArgv(runtime: string, mainPath: string, config: TickerConfig): string[] {
	return [runtime, mainPath, JSON.stringify(config)];
}
