import type { LatLon } from "@delacour/warden-config/conditions.types";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { geoMath } from "./geo";

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

/** What the detached child needs: the adb to call and the route to play. */
export type TickerConfig = TickerRoute & { adb: string; serial: string };

/** One running route: paces the fixes against the clock. */
class TickerRun {
	private readonly controller = new AbortController();
	private readonly steps: LatLon[];
	private readonly intervalMs: number;
	private readonly startedAt: number;
	private readonly count = { ticks: 0, failures: 0, index: 0 };
	private lastError = "";

	constructor(
		private readonly route: TickerRoute,
		private readonly deps: TickerDeps
	) {
		this.startedAt = deps.now();
		this.intervalMs = (route.intervalS ?? DEFAULT_INTERVAL_S) * 1000;
		this.steps = geoMath.routeSteps(
			route.points,
			route.speedMps ?? DEFAULT_SPEED_MPS,
			route.intervalS ?? DEFAULT_INTERVAL_S
		);
	}

	start(): RouteTicker {
		return { stop: () => this.controller.abort(), done: this.run() };
	}

	private *playlist(): Generator<LatLon> {
		do yield* this.steps;
		while (this.route.loop && this.steps.length > 0);
	}

	private async pace(done: number): Promise<boolean> {
		if (!this.route.loop && done >= this.steps.length) return false;
		await this.deps.sleep(
			Math.max(0, this.startedAt + done * this.intervalMs - this.deps.now()),
			this.controller.signal
		);
		return true;
	}

	private async sendOne(step: LatLon): Promise<boolean> {
		const failure = await this.deps.fix(step).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
		if (!failure) {
			this.count.failures = 0;
			this.count.ticks++;
			return true;
		}
		this.lastError = failure;
		this.count.failures++;
		return this.count.failures < MAX_CONSECUTIVE_FAILURES;
	}

	private async run(): Promise<TickerOutcome> {
		const { signal } = this.controller;
		for (const step of this.playlist()) {
			if (signal.aborted) return { ticks: this.count.ticks, stopped: "aborted" };
			if (!(await this.sendOne(step))) return { ticks: this.count.ticks, stopped: "failed", error: this.lastError };
			this.count.index++;
			if (!(await this.pace(this.count.index))) break;
		}
		return { ticks: this.count.ticks, stopped: signal.aborted ? "aborted" : "finished" };
	}
}

/** Plays routes as location fixes. Use the shared {@link routeTickers} singleton. */
export class RouteTickers {
	/**
	 * Plays `route` as one fix per `intervalS`, paced against the clock (a slow fix shortens the next
	 * sleep). Runs in this process: specs hold the handle and `stop()` it, a detached child runs the same
	 * loop from `route-ticker.main.ts`. Ends when the route is done (never, with `loop`), when stopped, or
	 * after {@link MAX_CONSECUTIVE_FAILURES} failed fixes in a row.
	 */
	start(route: TickerRoute, deps: TickerDeps): RouteTicker {
		return new TickerRun(route, deps).start();
	}

	parseConfig(raw: string): Result<TickerConfig> {
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			return resultFactory.err("route ticker config is not JSON");
		}
		if (typeof value !== "object" || value === null) return resultFactory.err("route ticker config must be an object");
		const c = value as Record<string, unknown>;
		if (typeof c.adb !== "string" || typeof c.serial !== "string")
			return resultFactory.err("route ticker config needs adb and serial");
		const points = c.points;
		const valid =
			Array.isArray(points) &&
			points.length > 0 &&
			points.every((p) => typeof p?.lat === "number" && typeof p?.lon === "number");
		if (!valid) return resultFactory.err("route ticker config needs a non-empty points list of { lat, lon }");
		return resultFactory.ok(c as unknown as TickerConfig);
	}

	/**
	 * argv that runs the ticker as its own process: `[runtime, route-ticker.main.ts, <config JSON>]`. The
	 * caller spawns it detached and stores the child's pid as an `OwnedProcess` with `recordCondition`, so
	 * COND-1 undo (`warden release`, gc) kills it.
	 */
	detachedArgv(runtime: string, mainPath: string, config: TickerConfig): string[] {
		return [runtime, mainPath, JSON.stringify(config)];
	}
}

export const routeTickers = new RouteTickers();
