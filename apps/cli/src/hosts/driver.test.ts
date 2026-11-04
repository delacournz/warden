import { afterEach, describe, expect, test } from "bun:test";
import { putHost } from "@delacour/warden-core/hosts/registry";
import { type TestContext, testContext } from "../testing";
import type { HostLease } from "./claim";
import { HOST_UI_VERBS, hostDriverArgv, hostVerbError } from "./driver";

const ctxs: TestContext[] = [];
afterEach(() => {
	for (const ctx of ctxs.splice(0)) ctx.cleanup();
});

const lease: HostLease = {
	id: "L1",
	resource: {
		kind: "host-device",
		host: "mac",
		remoteLeaseId: "R1",
		platform: "ios",
		id: "U1",
		name: "warden-iphone-1",
	},
	owner: { kind: "agent", sessionId: "s1", cwd: "/" },
	acquiredAt: 0,
	heartbeatAt: 0,
	ttlMs: 60_000,
};

describe("hostDriverArgv", () => {
	test("ssh to the host running its warden's __driver-serve on the remote lease, without the shared connection", () => {
		const ctx = testContext([]);
		ctxs.push(ctx);
		putHost(ctx.db, { name: "mac", ssh: { hostname: "mac.tail" }, wardenPath: "/w/warden", addedAt: 1 });
		const argv = hostDriverArgv(ctx, lease);
		expect(argv.success && argv.data.slice(-5)).toEqual(["--", "/w/warden", "__driver-serve", "--lease", "R1"]);
		expect(argv.success && argv.data.join(" ")).not.toContain("ControlMaster");
	});

	test("a host that was removed is HOST_UNKNOWN", () => {
		const ctx = testContext([]);
		ctxs.push(ctx);
		const argv = hostDriverArgv(ctx, lease);
		expect(!argv.success && argv.error).toStartWith("HOST_UNKNOWN: ");
	});
});

describe("host verbs", () => {
	test("driver verbs work on a host device; ones that run simctl / adb here do not", () => {
		for (const verb of ["snapshot", "press", "fill", "wait", "open", "close", "status"]) {
			expect(HOST_UI_VERBS.has(verb)).toBe(true);
		}
		for (const verb of ["snapshot", "press", "gesture swipe", "gesture longpress"]) {
			expect(hostVerbError(verb)).toBeUndefined();
		}
		for (const verb of ["screen rotate", "net", "location set", "screen video", "eval", "screen screenshot"]) {
			expect(hostVerbError(verb)?.code).toBe("usage");
		}
	});
});
