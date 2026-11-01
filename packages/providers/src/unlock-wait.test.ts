import { describe, expect, test } from "bun:test";
import { err, ok } from "@delacour/warden-types/result";
import {
	DEVICE_LOCKED_HINT,
	deviceLockedMessage,
	UNLOCK_POLL_MS,
	UNLOCK_PROGRESS_MS,
	UNLOCK_WAIT_MS,
	waitUnlocked,
} from "./unlock-wait";

/** A phone that reports `states` on successive reads (the last one repeats) and a clock that only sleeping moves. */
function rig(states: boolean[], opts: { noWait?: boolean; failRead?: boolean; abortAfter?: number } = {}) {
	let at = 0;
	let reads = 0;
	let sleeps = 0;
	const logs: string[] = [];
	const run = () =>
		waitUnlocked({
			name: "Test iPhone",
			noWait: opts.noWait ?? false,
			read: async () => {
				reads++;
				if (opts.failRead) return err("no answer");
				return ok({ locked: states[Math.min(reads - 1, states.length - 1)] ?? false });
			},
			now: () => at,
			sleep: async (ms) => {
				sleeps++;
				at += ms;
			},
			log: (line) => logs.push(line),
			...(opts.abortAfter === undefined ? {} : { abort: () => sleeps >= (opts.abortAfter ?? 0) }),
		});
	return { run, logs, reads: () => reads, elapsed: () => at };
}

describe("waitUnlocked", () => {
	test("an unlocked phone continues at once and prints nothing", async () => {
		const r = rig([false]);
		expect((await r.run()).success).toBe(true);
		expect(r.logs).toEqual([]);
		expect(r.reads()).toBe(1);
		expect(r.elapsed()).toBe(0);
	});

	test("locked, then unlocked on the 3rd poll: continues, said once up front", async () => {
		const r = rig([true, true, true, false]);
		expect((await r.run()).success).toBe(true);
		expect(r.logs).toEqual(["Test iPhone is locked: unlock it to continue (waiting up to 2m)"]);
		expect(r.elapsed()).toBe(3 * UNLOCK_POLL_MS);
	});

	test("locked the whole wait: device_locked after 2 minutes, with a progress line about every 30 s", async () => {
		const r = rig([true]);
		const result = await r.run();
		expect(result).toEqual({ success: false, error: expect.stringContaining("device_locked: Test iPhone is locked") });
		expect(r.elapsed()).toBe(UNLOCK_WAIT_MS);
		expect(UNLOCK_WAIT_MS).toBe(120_000);
		expect(r.logs).toHaveLength(1 + UNLOCK_WAIT_MS / UNLOCK_PROGRESS_MS - 1);
		expect(r.logs[1]).toContain("still locked");
	});

	test("--no-wait fails at once without sleeping or printing", async () => {
		const r = rig([true], { noWait: true });
		const result = await r.run();
		expect(!result.success && result.error).toBe(deviceLockedMessage("Test iPhone"));
		expect(r.elapsed()).toBe(0);
		expect(r.logs).toEqual([]);
	});

	test("a phone that does not answer is not this check's to judge", async () => {
		const r = rig([true], { failRead: true });
		expect((await r.run()).success).toBe(true);
		expect(r.logs).toEqual([]);
	});

	test("an aborted claim stops waiting", async () => {
		const r = rig([true], { abortAfter: 2 });
		const result = await r.run();
		expect(result.success).toBe(false);
		expect(r.elapsed()).toBe(2 * UNLOCK_POLL_MS);
	});

	test("the hint tells the user what to do", () => {
		expect(DEVICE_LOCKED_HINT).toBe("unlock the phone, then retry");
	});
});
