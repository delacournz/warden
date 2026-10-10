import { afterEach, describe, expect, test } from "bun:test";
import { simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import { fakeExec, type TestContext, testContext } from "../testing";
import { createSimCommand } from "./sim";

let ctx: TestContext | undefined;
afterEach(() => {
	ctx?.cleanup();
	ctx = undefined;
});

const BOOTED = simctlDevicesJson({
	"iOS-26-5": [
		{ udid: "U1", name: "a", state: "Booted" },
		{ udid: "U2", name: "b", state: "Shutdown" },
		{ udid: "U3", name: "c", state: "Booted" },
	],
});

function setup(argv: string[], calls: string[][] = []): TestContext {
	const exec = fakeExec(
		[
			["xcrun simctl list devices", { stdout: BOOTED }],
			["xcrun simctl spawn U1 launchctl print-disabled", { stdout: "" }],
			["xcrun simctl spawn U3 launchctl print-disabled", { stdout: "" }],
			["xcrun simctl spawn U1 launchctl list", { stdout: "PID\tStatus\tLabel\n9\t0\tcom.apple.healthd\n" }],
			["xcrun simctl spawn U3 launchctl list", { stdout: "PID\tStatus\tLabel\n" }],
			["xcrun simctl spawn", {}],
		],
		calls
	);
	ctx = testContext(argv, { exec });
	return ctx;
}

describe("warden sim slim", () => {
	test("<udid> --dry-run lists what would be disabled and changes nothing", async () => {
		const calls: string[][] = [];
		const c = setup(["slim", "U1", "--dry-run"], calls);
		expect(await createSimCommand().run(c)).toBe(0);
		expect(c.stderr.join("\n")).toContain("would disable");
		expect(calls.some((x) => x.includes("disable"))).toBe(false);
	});

	test("--booted slims every booted simulator, and only those", async () => {
		const calls: string[][] = [];
		const c = setup(["slim", "--booted"], calls);
		expect(await createSimCommand().run(c)).toBe(0);
		const touched = new Set(calls.filter((x) => x.includes("disable")).map((x) => x[3]));
		expect(touched).toEqual(new Set(["U1", "U3"]));
	});

	test("--restore re-enables; neither udid nor --booted is a usage error", async () => {
		const c = setup(["slim", "U1", "--restore"]);
		expect(await createSimCommand().run(c)).toBe(0);
		const none = setup(["slim"]);
		expect(await createSimCommand().run(none)).toBe(1);
		expect(none.stderr.join("\n")).toContain("pass <udid> or --booted");
	});

	test("refuses a simulator another session holds a lease on", async () => {
		const calls: string[][] = [];
		const c = setup(["slim", "U1"], calls);
		c.env = { ...c.env, WARDEN_SESSION_ID: "me" };
		c.store().insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "U1", name: "a" },
				owner: { kind: "agent", sessionId: "someone-else", cwd: "/x" },
				ttlMs: 60_000,
			},
			c.now()
		);
		expect(await createSimCommand().run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("leased by");
		expect(calls.some((x) => x.includes("disable"))).toBe(false);
	});

	test("records the slimmed state per device; --restore clears it; --dry-run leaves it", async () => {
		const c = setup(["slim", "U1", "--dry-run"]);
		c.db.recordDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1", profile: "iphone-17" }, 0);
		await createSimCommand().run(c);
		expect(c.db.listDevices()[0]?.slimmedAt).toBeUndefined();
		c.argv = ["slim", "U1"];
		expect(await createSimCommand().run(c)).toBe(0);
		expect(c.db.listDevices()[0]?.slimmedAt).toBe(c.now());
		c.argv = ["slim", "U1", "--restore"];
		expect(await createSimCommand().run(c)).toBe(0);
		expect(c.db.listDevices()[0]?.slimmedAt).toBeUndefined();
	});
});

describe("warden sim unquarantine", () => {
	test("clears quarantine; unknown id is an error", async () => {
		const c = setup(["unquarantine", "U1"]);
		c.db.quarantineDevice({ platform: "ios", id: "U1", name: "warden-iphone-17-1" }, "hung", 1);
		expect(await createSimCommand().run(c)).toBe(0);
		expect(c.db.listDevices()[0]?.quarantinedAt).toBeUndefined();
		expect(await createSimCommand().run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("not quarantined");
	});
});
