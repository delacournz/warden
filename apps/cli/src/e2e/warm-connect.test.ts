import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "@delacour/warden-core/exec";
import type { AxWedgeState } from "@delacour/warden-e2e/driver/ax-wedge";
import { fakeDriver, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import type { openIosDriver } from "@delacour/warden-e2e/driver/ios/ios-driver";
import { ok } from "@delacour/warden-types/result";
import { writeState } from "../agent-ui/state";
import { fakeExec, testContext } from "../testing";
import { AX_WEDGE_MARKER } from "./ax-wedge";
import { residentSocket, runnerWarmError, waitBooted, warmConnect } from "./warm-connect";

let home: string | undefined;
afterEach(() => {
	if (home) rmSync(home, { recursive: true, force: true });
	home = undefined;
});

function host() {
	home = mkdtempSync(join(tmpdir(), "warm-connect-"));
	return { env: { WARDEN_HOME: home }, now: () => 1_000 };
}

describe("residentSocket", () => {
	test("a recorded helper whose pid is alive and whose socket exists: its socket", async () => {
		const ctx = host();
		const socket = join(home ?? "", "U1.sock");
		writeFileSync(socket, "");
		// a stand-in whose command line carries the helper's `--udid <udid> --socket <socket>`
		const helper = Bun.spawn(["sh", "-c", "sleep 30; :", "sh", "--udid", "U1", "--socket", socket]);
		try {
			writeState(ctx, "U1", { generation: 0, helper: { pid: helper.pid, socket }, updatedAt: 1 });
			expect(await residentSocket(ctx)("U1")).toBe(socket);
		} finally {
			helper.kill("SIGKILL");
			await helper.exited;
		}
	});

	test("a recorded pid that now runs another program (reused): none (14-4)", async () => {
		const ctx = host();
		const socket = join(home ?? "", "U1.sock");
		writeFileSync(socket, "");
		writeState(ctx, "U1", { generation: 0, helper: { pid: process.pid, socket }, updatedAt: 1 });
		expect(await residentSocket(ctx)("U1")).toBeUndefined();
	});

	test("no record, a dead pid or a missing socket file: none", async () => {
		const ctx = host();
		expect(await residentSocket(ctx)("U1")).toBeUndefined();
		const socket = join(home ?? "", "U2.sock");
		writeFileSync(socket, "");
		writeState(ctx, "U2", { generation: 0, helper: { pid: 2 ** 22 + 17, socket }, updatedAt: 1 });
		expect(await residentSocket(ctx)("U2")).toBeUndefined();
		writeState(ctx, "U3", {
			generation: 0,
			helper: { pid: process.pid, socket: join(home ?? "", "gone.sock") },
			updatedAt: 1,
		});
		expect(await residentSocket(ctx)("U3")).toBeUndefined();
	});
});

describe("runnerWarmError", () => {
	test("a locked phone: the ui code first, then the message and the unlock hint", () => {
		expect(
			runnerWarmError({
				code: "device_locked",
				message: "E_DEVICE_LOCKED: Unlock the phone to Continue",
				hint: "unlock the phone, then retry",
			})
		).toBe("device_locked: E_DEVICE_LOCKED: Unlock the phone to Continue (unlock the phone, then retry)");
	});

	test("no hint: no parentheses", () => {
		expect(runnerWarmError({ code: "engine_unavailable", message: "no runner" })).toBe("engine_unavailable: no runner");
	});
});

describe("waitBooted", () => {
	const answer = (exitCode: number, stdout = "", stderr = ""): ExecResult => ({ exitCode, stdout, stderr });

	test("asks simctl bootstatus about the device, with a timeout, and reports nothing when it finished booting", async () => {
		const calls: Array<{ cmd: readonly string[]; timeoutMs: number | undefined }> = [];
		const note = await waitBooted(async (cmd, opts) => {
			calls.push({ cmd, timeoutMs: opts?.timeoutMs });
			return answer(0, "Status=Booted, isTerminal=YES");
		}, "U1");
		expect(note).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd).toEqual(["xcrun", "simctl", "bootstatus", "U1"]);
		expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
	});

	test("a device that is not booted, or a bootstatus that failed, is a note, never a throw", async () => {
		const note = await waitBooted(
			async () => answer(164, "", "Unable to get bootstatus for device that is not booted"),
			"U2"
		);
		expect(note).toContain("U2");
		expect(note).toContain("not booted");
	});

	test("a bootstatus that does not finish in time says so", async () => {
		const note = await waitBooted(async () => answer(124, "", "timed out"), "U3", 5_000);
		expect(note).toContain("U3");
	});
});

describe("warmConnect", () => {
	test("opens the simulator's driver with no cold bridge budget of its own: the warm loop paces the retries", async () => {
		const ctx = testContext([]);
		const opened: Array<Parameters<typeof openIosDriver>[0]> = [];
		const connect = warmConnect(ctx, {
			ensureHelper: async () => ok({ socketPath: "/tmp/U1.sock", spawned: false }),
			openIosDriver: async (options) => {
				opened.push(options);
				return ok(fakeDriver({ screens: [snapshotOf([])] }));
			},
		});
		const helper = await connect("U1");
		expect(helper.success).toBe(true);
		expect(opened).toHaveLength(1);
		expect(opened[0]?.coldBridgeBudgetMs).toBe(0);
		expect(opened[0]?.socketPath).toBe("/tmp/U1.sock");
		if (helper.success) await helper.data.close();
	});
	test("recover: a wedged sim gets backboardd restarted and the helper stopped, so the warm loop reconnects", async () => {
		const calls: string[][] = [];
		const ctx = testContext([], {
			exec: fakeExec(
				[
					["xcrun simctl bootstatus", {}],
					["xcrun simctl spawn U1 log show", { stdout: `x AXError: ${AX_WEDGE_MARKER}\n` }],
					["xcrun simctl spawn U1 launchctl kickstart", {}],
				],
				calls
			),
		});
		let closed = 0;
		const connect = warmConnect(ctx, {
			ensureHelper: async () => ok({ socketPath: "/tmp/U1.sock", spawned: false }),
			openIosDriver: async () => {
				const driver = fakeDriver({ screens: [snapshotOf([])] });
				return ok({
					...driver,
					close: async () => {
						closed++;
						await driver.close();
					},
				});
			},
		});
		const helper = await connect("U1");
		if (!helper.success) throw new Error(helper.error);
		const out = await helper.data.recover?.();
		expect(out?.kind).toBe("recovered");
		expect(calls.some((c) => c.join(" ").includes("kickstart -k user/foreground/com.apple.backboardd"))).toBe(true);
		expect(closed).toBe(1);
		ctx.cleanup();
	});

	test("recover: a sim that is not wedged keeps its helper", async () => {
		const ctx = testContext([], {
			exec: fakeExec([
				["xcrun simctl bootstatus", {}],
				["xcrun simctl spawn U1 log show", { stdout: "" }],
			]),
		});
		let closed = 0;
		const connect = warmConnect(ctx, {
			ensureHelper: async () => ok({ socketPath: "/tmp/U1.sock", spawned: false }),
			openIosDriver: async () => {
				const driver = fakeDriver({ screens: [snapshotOf([])] });
				return ok({
					...driver,
					close: async () => {
						closed++;
						await driver.close();
					},
				});
			},
		});
		const helper = await connect("U1");
		if (!helper.success) throw new Error(helper.error);
		expect((await helper.data.recover?.())?.kind).toBe("not-wedged");
		expect(closed).toBe(0);
		ctx.cleanup();
	});

	/** A driver whose helper does the wedge check itself (`axWedge`), answering `state` to a `recover: true` ask. */
	function helperDriven(state: AxWedgeState, asks: unknown[], closed: { count: number }) {
		return async () => {
			const driver = fakeDriver({ screens: [snapshotOf([])] });
			return ok({
				...driver,
				axWedge: async (opts?: { recover?: boolean }) => {
					asks.push(opts);
					return ok(state);
				},
				close: async () => {
					closed.count++;
					await driver.close();
				},
			});
		};
	}

	test("recover: a helper that checks for the wedge itself restarts backboardd; warden runs no simctl of its own", async () => {
		const calls: string[][] = [];
		const ctx = testContext([], { exec: fakeExec([["xcrun simctl bootstatus", {}]], calls) });
		const asks: unknown[] = [];
		const closed = { count: 0 };
		const connect = warmConnect(ctx, {
			ensureHelper: async () => ok({ socketPath: "/tmp/U1.sock", spawned: false }),
			openIosDriver: helperDriven(
				{
					restarts: 1,
					maxRestarts: 1,
					recovering: false,
					checked: "restarted",
					last: { outcome: "restarted", agoMs: 10, ms: 2300 },
				},
				asks,
				closed
			),
		});
		const helper = await connect("U1");
		if (!helper.success) throw new Error(helper.error);
		const out = await helper.data.recover?.();
		expect(out).toEqual({ kind: "recovered", note: "warden-simd restarted backboardd in 2300 ms" });
		expect(asks).toEqual([{ recover: true }]);
		expect(calls.some((c) => c.join(" ").includes("simctl spawn"))).toBe(false);
		expect(closed.count).toBe(1);
		ctx.cleanup();
	});

	test("recover: the helper's not-wedged and failed verdicts are passed on", async () => {
		for (const [state, kind] of [
			[
				{
					restarts: 0,
					maxRestarts: 1,
					recovering: false,
					checked: "not-wedged",
					last: { outcome: "not-wedged", agoMs: 5 },
				},
				"not-wedged",
			],
			[
				{
					restarts: 0,
					maxRestarts: 1,
					recovering: false,
					checked: "failed",
					last: { outcome: "failed", agoMs: 5, error: "log show: exit 1" },
				},
				"failed",
			],
			[{ restarts: 0, maxRestarts: 0, recovering: false }, "not-wedged"],
			[{ restarts: 1, maxRestarts: 1, recovering: false, last: { outcome: "restarted", agoMs: 90_000 } }, "failed"],
		] as const) {
			const calls: string[][] = [];
			const ctx = testContext([], { exec: fakeExec([["xcrun simctl bootstatus", {}]], calls) });
			const connect = warmConnect(ctx, {
				ensureHelper: async () => ok({ socketPath: "/tmp/U1.sock", spawned: false }),
				openIosDriver: helperDriven(state, [], { count: 0 }),
			});
			const helper = await connect("U1");
			if (!helper.success) throw new Error(helper.error);
			expect((await helper.data.recover?.())?.kind).toBe(kind);
			expect(calls.some((c) => c.join(" ").includes("simctl spawn"))).toBe(false);
			ctx.cleanup();
		}
	});
});
