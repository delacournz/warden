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

	test("--except / --keep leave categories and labels running; bad ids are a usage error", async () => {
		const calls: string[][] = [];
		const c = setup(["slim", "U1", "--except", "health, store", "--keep", "com.apple.swcd"], calls);
		expect(await createSimCommand().run(c)).toBe(0);
		const disabled = calls.filter((x) => x.includes("disable")).map((x) => x[x.indexOf("disable") + 1]);
		expect(disabled).toContain("system/com.apple.newsd");
		expect(disabled).not.toContain("system/com.apple.healthd");
		expect(disabled).not.toContain("system/com.apple.apsd");
		expect(disabled).not.toContain("system/com.apple.swcd");

		const bad = setup(["slim", "U1", "--except", "nope"]);
		expect(await createSimCommand().run(bad)).toBe(1);
		expect(bad.stderr.join("\n")).toContain("nope");
		const badLabel = setup(["slim", "U1", "--keep", "com.apple.searchd"]);
		expect(await createSimCommand().run(badLabel)).toBe(1);
		expect(badLabel.stderr.join("\n")).toContain("com.apple.searchd");
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

describe("warden sim profiles", () => {
	test("lists the 15 categories with label counts; --json is machine-readable", async () => {
		const c = setup(["profiles"]);
		expect(await createSimCommand().run(c)).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).toMatch(/widgets\s+4 labels/);
		expect(text.split("\n")).toHaveLength(15);

		const json = setup(["profiles", "--json"]);
		expect(await createSimCommand().run(json)).toBe(0);
		const rows = JSON.parse(json.stdout.join("\n")) as { id: string; labelCount: number }[];
		expect(rows).toHaveLength(15);
		expect(rows[0]).toMatchObject({ id: "widgets", labelCount: 4 });
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
