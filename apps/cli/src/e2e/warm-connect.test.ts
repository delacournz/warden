import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeState } from "../agent-ui/state";
import { residentSocket, runnerWarmError } from "./warm-connect";

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
