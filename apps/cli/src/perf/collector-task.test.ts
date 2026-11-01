import { describe, expect, test } from "bun:test";
import type { Capturer } from "@delacour/warden-perf/shared/session.schema";
import type { PerfPlan } from "@delacour/warden-sdk/ops/perf/plan";
import { type CaptureEnv, type CaptureKind, CaptureTask } from "./collector";

type Set = [CaptureKind, Partial<Omit<Capturer, "kind">>];

class ThrowingTask extends CaptureTask {
	readonly name = "metrics";
	enabled(plan: PerfPlan): boolean {
		return plan.metrics;
	}
	protected failedKinds(): readonly CaptureKind[] {
		return ["metrics"];
	}
	protected async run(): Promise<void> {
		throw new Error("boom");
	}
}

class OkTask extends CaptureTask {
	readonly name = "logs";
	ran = 0;
	enabled(plan: PerfPlan): boolean {
		return plan.logs;
	}
	protected failedKinds(): readonly CaptureKind[] {
		return ["logs"];
	}
	protected async run(): Promise<void> {
		this.ran += 1;
	}
}

function env(plan: Partial<PerfPlan>): { e: CaptureEnv; sets: Set[]; logs: string[] } {
	const sets: Set[] = [];
	const logs: string[] = [];
	const e = {
		plan: { metrics: true, logs: true, js: false, react: false, ...plan },
		deps: { log: (line: string) => logs.push(line) },
		set: (kind: CaptureKind, patch: Partial<Omit<Capturer, "kind">>) => sets.push([kind, patch]),
	} as unknown as CaptureEnv;
	return { e, sets, logs };
}

describe("CaptureTask", () => {
	test("guarded: a throwing run is logged under the task name and marks its kinds failed", async () => {
		const h = env({});
		await new ThrowingTask().guarded(h.e);
		expect(h.logs).toEqual(["metrics: boom"]);
		expect(h.sets).toEqual([["metrics", { state: "failed" }]]);
	});

	test("guarded: a clean run logs and sets nothing", async () => {
		const h = env({});
		const task = new OkTask();
		await task.guarded(h.e);
		expect(task.ran).toBe(1);
		expect(h.logs).toEqual([]);
		expect(h.sets).toEqual([]);
	});

	test("enabled follows the plan", () => {
		expect(new OkTask().enabled({ logs: false } as PerfPlan)).toBe(false);
		expect(new OkTask().enabled({ logs: true } as PerfPlan)).toBe(true);
	});
});
