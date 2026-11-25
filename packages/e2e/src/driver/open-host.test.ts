import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type E2eEnv, readEnv } from "../env";
import { openDriver } from "./open";

const FIXTURE = join(import.meta.dir, "remote", "remote-stdio.fixture.ts");

const base: E2eEnv = {
	udid: "U1",
	platform: "android",
	bundleId: "com.example",
	launchArgs: [],
	out: "out",
	timeoutMs: 1000,
	actionTimeoutMs: 1000,
	assertionTimeoutMs: 1000,
	logTimestamps: false,
};

describe("a host's device (WARDEN_HOST_DRIVER)", () => {
	test("readEnv takes the host and the JSON argv that serves its driver", () => {
		const r = readEnv({
			WARDEN_UDID: "U1",
			WARDEN_BUNDLE_ID: "com.example",
			WARDEN_HOST: "mac",
			WARDEN_HOST_DRIVER: JSON.stringify(["ssh", "mac", "--", "warden", "__driver-serve", "--lease", "R1"]),
		});
		expect(r.success && r.data?.host).toBe("mac");
		expect(r.success && r.data?.hostDriver).toEqual(["ssh", "mac", "--", "warden", "__driver-serve", "--lease", "R1"]);
		const bad = readEnv({ WARDEN_UDID: "U1", WARDEN_BUNDLE_ID: "x", WARDEN_HOST_DRIVER: "[]" });
		expect(bad.success).toBe(false);
	});

	test("openDriver connects to the served driver over that command's stdio", async () => {
		const opened = await openDriver({ ...base, host: "fixture", hostDriver: ["bun", FIXTURE] });
		if (!opened.success) throw new Error(opened.error.message);
		const shot = await opened.data.snapshot();
		expect(shot.success && shot.data.flat.map((e) => e.label)).toEqual(["From the fixture"]);
		await opened.data.close();
	});
});
