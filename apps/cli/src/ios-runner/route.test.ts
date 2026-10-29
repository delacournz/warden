import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { Exec } from "@delacour/warden-core/exec";
import { devicectlList, parseTunnel, readTunnelIp, waitTunnelConnected } from "./route";

const UDID = "00008140-000A0B0C0D0E0F10";

const listing = (state: string, ip?: string, udid = UDID, reality = "physical") => ({
	result: {
		devices: [
			{
				hardwareProperties: { udid, reality },
				connectionProperties: { tunnelState: state, ...(ip !== undefined ? { tunnelIPAddress: ip } : {}) },
			},
		],
	},
});

describe("parseTunnel", () => {
	test("reads the address and state of the physical device", () => {
		expect(parseTunnel(listing("connected", "fdcf:4c26:82c4::1"), UDID)).toEqual({
			ip: "fdcf:4c26:82c4::1",
			state: "connected",
		});
	});
	test("a disconnected tunnel has no ip; an unlisted, non-physical or malformed device is undefined", () => {
		expect(parseTunnel(listing("disconnected"), UDID)).toEqual({ state: "disconnected" });
		expect(parseTunnel(listing("connected", "x", "OTHER"), UDID)).toBeUndefined();
		expect(parseTunnel(listing("connected", "x", UDID, "virtual"), UDID)).toBeUndefined();
		expect(parseTunnel("nope", UDID)).toBeUndefined();
	});
});

describe("waitTunnelConnected", () => {
	function clock(states: Array<ReturnType<typeof listing>>) {
		let t = 0;
		let reads = 0;
		return {
			reads: () => reads,
			deps: {
				list: async () => ({ success: true as const, data: states[Math.min(reads++, states.length - 1)] }),
				sleep: async (ms: number) => {
					t += ms;
				},
				now: () => t,
			},
		};
	}

	test("waits through a disconnected tunnel and returns the address once connected", async () => {
		const c = clock([listing("disconnected"), listing("connecting"), listing("connected", "fd00::1")]);
		expect(await waitTunnelConnected(c.deps, UDID, 10_000)).toEqual({ success: true, data: "fd00::1" });
		expect(c.reads()).toBe(3);
	});

	test("gives up with not_connected after the timeout", async () => {
		const c = clock([listing("disconnected")]);
		const result = await waitTunnelConnected(c.deps, UDID, 2000);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.kind).toBe("not_connected");
	});

	test("an unlisted device is not_listed", async () => {
		const c = clock([{ result: { devices: [] } }]);
		const result = await waitTunnelConnected(c.deps, UDID, 600);
		if (result.success) throw new Error("expected failure");
		expect(result.error.kind).toBe("not_listed");
	});
});

describe("readTunnelIp", () => {
	test("re-reads on every call: the address changes after an install", async () => {
		const answers = [listing("connected", "fd00::1"), listing("connected", "fd00::2")];
		const list = async () => ({ success: true as const, data: answers.shift() });
		expect(await readTunnelIp({ list }, UDID)).toEqual({ success: true, data: "fd00::1" });
		expect(await readTunnelIp({ list }, UDID)).toEqual({ success: true, data: "fd00::2" });
	});

	test("an exec failure is list_failed", async () => {
		const result = await readTunnelIp({ list: async () => ({ success: false, error: "boom" }) }, UDID);
		if (result.success) throw new Error("expected failure");
		expect(result.error).toEqual({ kind: "list_failed", message: "boom" });
	});
});

describe("devicectlList", () => {
	test("runs devicectl with --json-output and parses the file it wrote", async () => {
		const calls: string[][] = [];
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			writeFileSync(cmd[cmd.length - 1] as string, JSON.stringify(listing("connected", "fd00::9")));
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		const listed = await devicectlList({ exec })();
		expect(listed).toEqual({ success: true, data: listing("connected", "fd00::9") });
		expect(calls[0]?.slice(0, 5)).toEqual(["xcrun", "devicectl", "list", "devices", "--json-output"]);
	});

	test("a failing devicectl reports its stderr", async () => {
		const exec: Exec = async () => ({ exitCode: 1, stdout: "", stderr: "no CoreDevice" });
		const listed = await devicectlList({ exec })();
		expect(listed).toEqual({ success: false, error: "devicectl list devices failed: no CoreDevice" });
	});
});
