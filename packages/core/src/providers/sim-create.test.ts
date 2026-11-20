import { describe, expect, test } from "bun:test";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { CREATE_RETRY, createAcceptingRuntime } from "./sim-create";

const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-27-2";
const REFUSED = `\`xcrun simctl create warden-iphone-17-1 x ${RUNTIME}\` exited 145: Invalid runtime: ${RUNTIME}`;

/** A clock the fake `sleep` advances, and the attempt results in order (the last one repeats). */
function harness(results: Array<() => AsyncResult<string>>) {
	let clock = 1_000;
	const slept: number[] = [];
	const logs: string[] = [];
	let calls = 0;
	const attempt = (): AsyncResult<string> => {
		const next = results[Math.min(calls, results.length - 1)];
		calls += 1;
		if (!next) throw new Error("no result");
		return next();
	};
	const deps = {
		now: () => clock,
		sleep: async (ms: number) => {
			slept.push(ms);
			clock += ms;
		},
		log: (line: string) => void logs.push(line),
	};
	return { attempt, deps, slept, logs, calls: () => calls };
}

const refused = async () => err(REFUSED);
const created = async () => ok("NEW-UDID\n");

describe("createAcceptingRuntime", () => {
	test("a create that works first time is returned without waiting", async () => {
		const h = harness([created]);
		expect(await createAcceptingRuntime(h.attempt, RUNTIME, h.deps)).toEqual(ok("NEW-UDID\n"));
		expect(h.calls()).toBe(1);
		expect(h.slept).toEqual([]);
		expect(h.logs).toEqual([]);
	});

	test("an Invalid runtime refusal is retried until the runtime takes the device", async () => {
		const h = harness([refused, refused, created]);
		expect(await createAcceptingRuntime(h.attempt, RUNTIME, h.deps)).toEqual(ok("NEW-UDID\n"));
		expect(h.calls()).toBe(3);
		expect(h.slept).toEqual([CREATE_RETRY.pollMs, CREATE_RETRY.pollMs]);
		expect(h.logs).toEqual([
			`iOS-27-2 is listed but refuses new simulators yet (Invalid runtime); retrying for up to ${CREATE_RETRY.waitMs / 1000}s`,
			`iOS-27-2 accepted the simulator after ${(2 * CREATE_RETRY.pollMs) / 1000}s`,
		]);
	});

	test("a runtime that keeps refusing fails after the wait with how long it was refused", async () => {
		const h = harness([refused]);
		const result = await createAcceptingRuntime(h.attempt, RUNTIME, h.deps);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toBe(
			`${REFUSED} (iOS-27-2 is listed by simctl list runtimes but refused new simulators for ${CREATE_RETRY.waitMs / 1000}s)`
		);
		const waited = h.slept.reduce((a, b) => a + b, 0);
		expect(waited).toBe(CREATE_RETRY.waitMs);
		expect(h.calls()).toBe(CREATE_RETRY.waitMs / CREATE_RETRY.pollMs + 1);
	});

	test("any other failure is returned at once", async () => {
		const h = harness([async () => err("`xcrun simctl create …` exited 1: Invalid device type: iPhone-99")]);
		const result = await createAcceptingRuntime(h.attempt, RUNTIME, h.deps);
		expect(result).toEqual(err("`xcrun simctl create …` exited 1: Invalid device type: iPhone-99"));
		expect(h.calls()).toBe(1);
		expect(h.slept).toEqual([]);
	});

	test("a timed-out create is not retried (it already spent its own budget)", async () => {
		const h = harness([async () => err("`xcrun simctl create …` did not finish within 120s")]);
		expect((await createAcceptingRuntime(h.attempt, RUNTIME, h.deps)).success).toBe(false);
		expect(h.calls()).toBe(1);
	});

	test("a clock that never moves still ends the wait (slept time counts)", async () => {
		let calls = 0;
		const result = await createAcceptingRuntime(
			async () => {
				calls += 1;
				return err(REFUSED);
			},
			RUNTIME,
			{ now: () => 42, sleep: async () => {} }
		);
		expect(result.success).toBe(false);
		expect(calls).toBe(CREATE_RETRY.waitMs / CREATE_RETRY.pollMs + 1);
	});

	test("the last sleep is cut to what is left of the wait", async () => {
		const h = harness([refused]);
		await createAcceptingRuntime(h.attempt, RUNTIME, h.deps, { waitMs: 5_000, pollMs: 2_000 });
		expect(h.slept).toEqual([2_000, 2_000, 1_000]);
		expect(h.calls()).toBe(4);
	});
});
