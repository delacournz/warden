import type { LocationCondition, NetworkCondition } from "@delacour/warden-config/conditions.types";
import type { FlapOptions, TimelineStep } from "@delacour/warden-driver/conditions/scheduler";
import type { Lease } from "@delacour/warden-store/types";
import { type Result, resultFactory } from "@delacour/warden-types/result";

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
	/** iOS only: argv prefix that starts the shaping proxy when the schedule needs one (a compiled `warden`: its `__netproxy`); default `bun netproxy.main.ts` */
	proxyCommand?: string[];
} & ({ mode: "flap"; flap: FlapOptions } | { mode: "timeline"; steps: TimelineStep[] });

/** Reads and validates a detached scheduler's config. */
export class SchedulerConfigs {
	parse(raw: string): Result<SchedulerConfig> {
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			return resultFactory.err("scheduler config is not JSON");
		}
		if (!this.isObject(value)) return resultFactory.err("scheduler config must be an object");
		const problem = this.deviceProblem(value) ?? this.modeProblem(value);
		return problem === undefined ? resultFactory.ok(value as unknown as SchedulerConfig) : resultFactory.err(problem);
	}

	/**
	 * argv that runs the scheduler as its own process: `[runtime, scheduler.main.ts, <config JSON>]`. The caller
	 * spawns it detached and stores the child's pid as an `OwnedProcess` with `recordCondition`, so COND-1 undo
	 * (`warden release`, gc) kills it; the child restores the flap's base on SIGTERM.
	 */
	detachedArgv(runtime: string, mainPath: string, config: SchedulerConfig): string[] {
		return [runtime, mainPath, JSON.stringify(config)];
	}

	private isObject(v: unknown): v is Record<string, unknown> {
		return typeof v === "object" && v !== null;
	}

	private isNetwork(v: unknown): v is NetworkCondition {
		return this.isObject(v) && typeof v.kind === "string";
	}

	private isLocation(v: unknown): v is LocationCondition {
		return this.isObject(v) && typeof v.kind === "string";
	}

	private modeProblem(value: Record<string, unknown>): string | undefined {
		if (value.mode === "flap") return this.flapProblem(value);
		if (value.mode === "timeline") return this.timelineProblem(value);
		return "scheduler config needs mode flap|timeline";
	}

	private flapProblem(value: Record<string, unknown>): string | undefined {
		const f = value.flap;
		if (!this.isObject(f) || typeof f.upMs !== "number" || typeof f.downMs !== "number") {
			return "scheduler flap config needs upMs and downMs";
		}
		return f.base !== undefined && !this.isNetwork(f.base)
			? "scheduler flap base must be a network condition"
			: undefined;
	}

	private isStep(s: unknown): boolean {
		if (!this.isObject(s) || typeof s.atMs !== "number") return false;
		if (s.network !== undefined && !this.isNetwork(s.network)) return false;
		if (s.location !== undefined && !this.isLocation(s.location)) return false;
		return s.network !== undefined || s.location !== undefined;
	}

	private timelineProblem(value: Record<string, unknown>): string | undefined {
		const steps = value.steps;
		const valid = Array.isArray(steps) && steps.length > 0 && steps.every((s) => this.isStep(s));
		return valid ? undefined : "scheduler timeline needs steps with atMs and a network or location";
	}

	private deviceProblem(value: Record<string, unknown>): string | undefined {
		if (value.platform !== "android" && value.platform !== "ios") return "scheduler config needs platform android|ios";
		if (typeof value.id !== "string" || value.id === "") return "scheduler config needs a device id";
		if (value.platform === "android" && typeof value.adb !== "string") return "scheduler config needs adb for android";
		if (value.events !== undefined && typeof value.events !== "string") return "scheduler config events must be a path";
		if (value.platform === "ios") {
			const lease = value.lease;
			const valid =
				this.isObject(lease) &&
				typeof lease.id === "string" &&
				this.isObject(lease.owner) &&
				typeof lease.ttlMs === "number";
			if (!valid) return "scheduler config needs lease { id, owner, ttlMs } for ios";
		}
		return undefined;
	}
}

export const schedulerConfigs = new SchedulerConfigs();
