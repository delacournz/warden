import { describe, expect, test } from "bun:test";
import { ok } from "@delacour/warden-types/result";
import type { WardenApi } from "./api";
import type { DeviceTokenPoll } from "./api.types";
import { pollDeviceToken } from "./device-login";

function apiPolling(polls: DeviceTokenPoll[]): Pick<WardenApi, "deviceToken"> {
	return { deviceToken: async () => ok(polls.shift() ?? { kind: "pending" }) };
}

function clock() {
	let t = 0;
	const sleeps: number[] = [];
	return {
		sleeps,
		now: () => t,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			t += ms;
		},
	};
}

const code = { deviceCode: "dc", userCode: "U", verificationUri: "https://x", expiresIn: 60, interval: 5 };

describe("pollDeviceToken", () => {
	test("waits the interval between polls and returns the token", async () => {
		const c = clock();
		const r = await pollDeviceToken(apiPolling([{ kind: "pending" }, { kind: "token", token: "tok" }]), code, c);
		expect(r).toEqual({ success: true, data: "tok" });
		expect(c.sleeps).toEqual([5000, 5000]);
	});

	test("slow_down adds 5 s to the interval for the rest of the wait", async () => {
		const c = clock();
		await pollDeviceToken(
			apiPolling([{ kind: "slow_down" }, { kind: "pending" }, { kind: "token", token: "t" }]),
			code,
			c
		);
		expect(c.sleeps).toEqual([5000, 10000, 10000]);
	});

	test("denied and expired end the wait", async () => {
		expect(await pollDeviceToken(apiPolling([{ kind: "denied" }]), code, clock())).toEqual({
			success: false,
			error: "login was denied in the browser",
		});
		expect(await pollDeviceToken(apiPolling([{ kind: "expired" }]), code, clock())).toEqual({
			success: false,
			error: "the login code expired; run warden login again",
		});
	});

	test("gives up at expires_in", async () => {
		const c = clock();
		const r = await pollDeviceToken(apiPolling([]), { ...code, expiresIn: 12 }, c);
		expect(r.success).toBe(false);
		expect(c.now()).toBeGreaterThanOrEqual(12_000);
	});
});
