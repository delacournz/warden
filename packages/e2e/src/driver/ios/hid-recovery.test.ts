import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "@delacour/warden-core/exec";
import { E2eError } from "../../errors";
import { isHidLost, rebootSim, stopResidentHelper } from "./hid-recovery";
import type { SimdClient } from "./simd-client";

const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

function script(replies: Record<string, ExecResult>) {
	const calls: string[] = [];
	const exec: Exec = async (cmd) => {
		const line = cmd.join(" ");
		calls.push(line);
		return replies[line] ?? ok;
	};
	return { exec, calls };
}

describe("isHidLost", () => {
	const lost =
		"tap failed: E_HID: The dtuhidd connection (com.apple.coredevice.feature.remote.hid.digitizer) has been invalidated; events sent on it would be discarded";
	test("the invalidated dtuhidd connection, however the error was wrapped", () => {
		expect(isHidLost(new E2eError("ACTION_FAILED", lost))).toBe(true);
		expect(isHidLost(new E2eError("DRIVER", lost))).toBe(true);
	});
	test("other E_HID refusals and other errors are not it", () => {
		expect(isHidLost(new E2eError("ACTION_FAILED", "tap failed: E_HID: no hid"))).toBe(false);
		expect(isHidLost(new E2eError("ASSERTION", "expected visible"))).toBe(false);
		expect(isHidLost("E_HID dtuhidd invalidated")).toBe(false);
	});
});

describe("rebootSim", () => {
	test("shutdown, then bootstatus -b boots it again and waits (no Simulator.app)", async () => {
		const { exec, calls } = script({});
		const result = await rebootSim({ exec }, "U-1");
		expect(result.success).toBe(true);
		expect(calls).toEqual(["xcrun simctl shutdown U-1", "xcrun simctl bootstatus U-1 -b"]);
	});
	test("an already shut down sim (exit 164) is fine", async () => {
		const { exec } = script({
			"xcrun simctl shutdown U-1": {
				exitCode: 164,
				stdout: "",
				stderr: "Unable to shutdown device in current state: Shutdown",
			},
		});
		expect((await rebootSim({ exec }, "U-1")).success).toBe(true);
	});
	test("Xcode 27.1 reports an already shut down sim as exit 149 with the state text", async () => {
		const { exec } = script({
			"xcrun simctl shutdown U-1": {
				exitCode: 149,
				stdout: "",
				stderr:
					"An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405): Unable to shutdown device in current state: Shutdown",
			},
		});
		expect((await rebootSim({ exec }, "U-1")).success).toBe(true);
	});
	test("a failed shutdown stops before booting", async () => {
		const { exec, calls } = script({
			"xcrun simctl shutdown U-1": { exitCode: 1, stdout: "", stderr: "boom" },
		});
		const result = await rebootSim({ exec }, "U-1");
		expect(result.success).toBe(false);
		expect(calls).toHaveLength(1);
	});
	test("a failed boot is an error", async () => {
		const { exec } = script({
			"xcrun simctl bootstatus U-1 -b": { exitCode: 1, stdout: "", stderr: "no" },
		});
		const result = await rebootSim({ exec }, "U-1");
		expect(result.success).toBe(false);
	});
});

describe("stopResidentHelper", () => {
	function fakeDaemon(opts: { connects?: boolean; goesAway?: boolean } = {}) {
		const requests: string[] = [];
		let present = true;
		const client = {
			ready: Promise.resolve(),
			request: async (op: string) => {
				requests.push(op);
				if (opts.goesAway !== false) present = false;
				return { success: true as const, data: {} };
			},
			close: async () => {
				requests.push("close");
			},
		} as unknown as SimdClient;
		const deps = {
			exec: script({}).exec,
			connect: async () =>
				opts.connects === false
					? { success: false as const, error: { code: "E_HELPER_CRASHED" as const, message: "gone", retryable: false } }
					: { success: true as const, data: client },
			socketExists: () => present,
			sleep: async () => {},
		};
		return { deps, requests };
	}

	test("asks the daemon on the socket to shut down and waits for the socket to vanish", async () => {
		const { deps, requests } = fakeDaemon();
		const result = await stopResidentHelper(deps, "/h/simd/U-1.sock");
		expect(result).toEqual({ success: true, data: "stopped" });
		expect(requests).toEqual(["shutdown", "close"]);
	});
	test("a daemon that stays after shutdown is an error", async () => {
		const { deps } = fakeDaemon({ goesAway: false });
		expect((await stopResidentHelper(deps, "/s")).success).toBe(false);
	});
	test("no daemon on the socket: nothing to stop", async () => {
		const { deps, requests } = fakeDaemon({ connects: false });
		expect(await stopResidentHelper(deps, "/s")).toEqual({ success: true, data: "none" });
		expect(requests).toEqual([]);
	});
});
