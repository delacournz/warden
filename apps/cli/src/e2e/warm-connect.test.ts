import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "@delacour/warden-core/exec";
import { fakeDriver, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import type { openIosDriver } from "@delacour/warden-e2e/driver/ios/ios-driver";
import { ok } from "@delacour/warden-types/result";
import { writeState } from "../agent-ui/state";
import { testContext } from "../testing";
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
});
