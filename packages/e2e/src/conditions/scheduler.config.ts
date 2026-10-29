import type { LocationCondition, NetworkCondition } from "@delacour/warden-core/conditions/conditions.types";
import type { Lease } from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { FlapOptions, TimelineStep } from "./scheduler";

export type SchedulerPlatform = "android" | "ios";

/** What the detached child needs: which device to drive, what to run, and where to write evidence. */
export type SchedulerConfig = {
	platform: SchedulerPlatform;
	/** serial (Android) or udid (iOS) */
	id: string;
	/** Android only: the `adb` binary */
	adb?: string;
	/** a `results.jsonl` to append `condition` events to */
	events?: string;
	/** iOS only: the lease whose shaping proxy the network steps drive (`id` names its handle file; `owner` / `ttlMs` start a proxy that is not up yet) */
	lease?: Pick<Lease, "id" | "owner" | "ttlMs">;
	/** iOS only: the app the injected dylib state belongs to */
	bundleId?: string;
} & ({ mode: "flap"; flap: FlapOptions } | { mode: "timeline"; steps: TimelineStep[] });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isNetwork = (v: unknown): v is NetworkCondition => isObject(v) && typeof v.kind === "string";
const isLocation = (v: unknown): v is LocationCondition => isObject(v) && typeof v.kind === "string";

function flapProblem(value: Record<string, unknown>): string | undefined {
	const f = value.flap;
	if (!isObject(f) || typeof f.upMs !== "number" || typeof f.downMs !== "number") {
		return "scheduler flap config needs upMs and downMs";
	}
	return f.base !== undefined && !isNetwork(f.base) ? "scheduler flap base must be a network condition" : undefined;
}

function isStep(s: unknown): boolean {
	if (!isObject(s) || typeof s.atMs !== "number") return false;
	if (s.network !== undefined && !isNetwork(s.network)) return false;
	if (s.location !== undefined && !isLocation(s.location)) return false;
	return s.network !== undefined || s.location !== undefined;
}

function timelineProblem(value: Record<string, unknown>): string | undefined {
	const steps = value.steps;
	const valid = Array.isArray(steps) && steps.length > 0 && steps.every(isStep);
	return valid ? undefined : "scheduler timeline needs steps with atMs and a network or location";
}

function deviceProblem(value: Record<string, unknown>): string | undefined {
	if (value.platform !== "android" && value.platform !== "ios") return "scheduler config needs platform android|ios";
	if (typeof value.id !== "string" || value.id === "") return "scheduler config needs a device id";
	if (value.platform === "android" && typeof value.adb !== "string") return "scheduler config needs adb for android";
	if (value.events !== undefined && typeof value.events !== "string") return "scheduler config events must be a path";
	if (value.platform === "ios") {
		const lease = value.lease;
		const valid =
			isObject(lease) && typeof lease.id === "string" && isObject(lease.owner) && typeof lease.ttlMs === "number";
		if (!valid) return "scheduler config needs lease { id, owner, ttlMs } for ios";
	}
	return undefined;
}

export function parseSchedulerConfig(raw: string): Result<SchedulerConfig> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return err("scheduler config is not JSON");
	}
	if (!isObject(value)) return err("scheduler config must be an object");
	const problem =
		deviceProblem(value) ??
		(value.mode === "flap"
			? flapProblem(value)
			: value.mode === "timeline"
				? timelineProblem(value)
				: "scheduler config needs mode flap|timeline");
	return problem === undefined ? ok(value as unknown as SchedulerConfig) : err(problem);
}

/**
 * argv that runs the scheduler as its own process: `[runtime, scheduler.main.ts, <config JSON>]`. The caller
 * spawns it detached and stores the child's pid as an `OwnedProcess` with `recordCondition`, so COND-1 undo
 * (`warden release`, gc) kills it; the child restores the flap's base on SIGTERM.
 */
export function detachedSchedulerArgv(runtime: string, mainPath: string, config: SchedulerConfig): string[] {
	return [runtime, mainPath, JSON.stringify(config)];
}
