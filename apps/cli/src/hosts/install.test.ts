import { describe, expect, test } from "bun:test";
import { el, fakeDriver, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { type TestContext, testContext } from "../testing";
import type { HostLease } from "./claim";
import { installOnHost } from "./install";

const lease: HostLease = {
	id: "L1",
	resource: { kind: "host-device", host: "mac", remoteLeaseId: "R1", platform: "ios", id: "U1", name: "iphone" },
	owner: { kind: "agent", sessionId: "s", cwd: "/" },
	acquiredAt: 0,
	heartbeatAt: 0,
	ttlMs: 60_000,
};

describe("installOnHost", () => {
	test("uploads the build, then installs the host's copy through the host's driver, and closes it", async () => {
		const ctx: TestContext = testContext([]);
		const driver = fakeDriver({
			platform: "ios",
			screens: [snapshotOf([el("text", { label: "x" })], { platform: "ios" })],
		});
		let closed = false;
		const r = await installOnHost(ctx, lease, "/local/Example.app", {
			upload: async (_c, host, path) => {
				expect([host, path]).toEqual(["mac", "/local/Example.app"]);
				return { success: true, data: "/h/uploads/abc/Example.app" };
			},
			connect: async () => ({
				success: true,
				data: {
					...driver,
					close: async () => {
						closed = true;
					},
				},
			}),
		});
		expect(r).toEqual({ success: true, data: "/h/uploads/abc/Example.app" });
		expect(driver.calls.some((c) => c.method === "app.install" && c.path === "/h/uploads/abc/Example.app")).toBe(true);
		expect(closed).toBe(true);
		ctx.cleanup();
	});

	test("a failed upload never opens the driver", async () => {
		const ctx = testContext([]);
		let opened = false;
		const r = await installOnHost(ctx, lease, "/x.app", {
			upload: async () => ({ success: false, error: "HOST_UNREACHABLE: mac: down" }),
			connect: async () => {
				opened = true;
				return { success: false, error: { code: "failed", message: "x" } };
			},
		});
		expect(!r.success && r.error).toContain("HOST_UNREACHABLE");
		expect(opened).toBe(false);
		ctx.cleanup();
	});
});
