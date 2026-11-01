import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverFixtures, FakeDriver } from "@delacour/warden-driver/testing/driver";
import type { DeviceProvider } from "@delacour/warden-providers/provider.types";
import type { ExecResult } from "@delacour/warden-runtime/exec";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import { wardenErrors } from "@delacour/warden-types/error";
import { resultFactory } from "@delacour/warden-types/result";
import { createWardenClient } from "./client";
import type { ClientSeams } from "./core";
import type { WardenClientOptions, WardenEvent } from "./sdk.types";

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const HID_LOST =
	"tap failed: E_HID: The dtuhidd connection (com.apple.coredevice.feature.remote.hid.digitizer) has been invalidated; events sent on it would be discarded";

let dir: string;
let peek: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-sdk-wsdx4-"));
	peek = storeLocator.open(join(dir, "warden.db"));
});

afterEach(() => {
	peek.close();
	rmSync(dir, { recursive: true, force: true });
});

const provider: DeviceProvider = {
	platform: "ios",
	inventory: async () =>
		resultFactory.ok([
			{
				platform: "ios",
				id: UDID,
				name: "warden-iphone-17-1",
				state: "booted",
				wardenCreated: false,
				runtime: "iOS-26-5",
			},
		]),
	create: async () => wardenErrors.err("failed", "no create in this fake"),
	boot: async () => resultFactory.ok(undefined),
	waitReady: async () => resultFactory.ok(undefined),
	shutdown: async () => resultFactory.ok(undefined),
};

type Rig = {
	seams: ClientSeams;
	options: WardenClientOptions;
	events: WardenEvent[];
	execs: string[];
	opened: FakeDriver[];
};

function rig(
	drivers: () => FakeDriver,
	exec: (cmd: string) => ExecResult = () => ({ exitCode: 0, stdout: "", stderr: "" })
): Rig {
	const events: WardenEvent[] = [];
	const execs: string[] = [];
	const opened: FakeDriver[] = [];
	return {
		events,
		execs,
		opened,
		seams: {
			providerFor: () => provider,
			stopHelper: async () => undefined,
			openDriver: async () => {
				const driver = drivers();
				opened.push(driver);
				return resultFactory.ok(driver);
			},
		},
		options: {
			home: dir,
			host: {
				env: {
					WARDEN_CAPACITY: "off",
					WARDEN_ARRANGE: "0",
					WARDEN_BACKGROUND: "0",
					WARDEN_SESSION_ID: "sdk-wsdx4",
					WARDEN_HOME: dir,
					HOME: "/nonexistent",
				},
				cwd: dir,
				exec: async (cmd) => {
					const line = cmd.join(" ");
					execs.push(line);
					return exec(line);
				},
			},
			onEvent: (event) => events.push(event),
		},
	};
}

const screen = () => driverFixtures.snapshotOf([driverFixtures.el("button", { id: "go", label: "Go" })]);

describe("shared claims", () => {
	test("claim({ shared }) marks the lease shared, in the returned row and the store", async () => {
		const r = rig(() => new FakeDriver({ screens: [screen()] }));
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios", shared: true });
		expect(lease?.shared).toBe(true);
		expect(peek.getLease(lease?.id ?? "")?.shared).toBe(true);
		const [listed] = await warden.leases.list({ mine: true });
		expect(listed?.shared).toBe(true);
	});

	test("a plain claim is not shared", async () => {
		const r = rig(() => new FakeDriver({ screens: [screen()] }));
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		expect(lease?.shared).toBeFalsy();
	});
});

describe("HID recovery in an iOS session", () => {
	test("a lost HID connection reboots the sim, reopens the driver and runs the call again, once", async () => {
		let opens = 0;
		const r = rig(() => {
			opens += 1;
			const first = opens === 1;
			return new FakeDriver({
				screens: [screen()],
				onCall: (call) => (first && call.method === "tap" ? driverFixtures.failWith("E_HID", HID_LOST) : undefined),
			});
		});
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
		await session.interactions.press({ selector: "id=go" });
		expect(r.execs).toEqual([`xcrun simctl shutdown ${UDID}`, `xcrun simctl bootstatus ${UDID} -b`]);
		expect(opens).toBe(2);
		expect(r.opened[1]?.callsOf("tap")).toHaveLength(1);
		expect(r.events.some((e) => e.kind === "warn" && e.message.includes("rebooted"))).toBe(true);
	});

	test("a second loss in the same session fails as before", async () => {
		const r = rig(
			() =>
				new FakeDriver({
					screens: [screen()],
					onCall: (call) => (call.method === "tap" ? driverFixtures.failWith("E_HID", HID_LOST) : undefined),
				})
		);
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
		const failure = await session.interactions.press({ selector: "id=go" }).catch((e: unknown) => e);
		expect(failure).toMatchObject({ message: expect.stringContaining("E_HID") });
		expect(r.execs.filter((c) => c.includes("shutdown"))).toHaveLength(1);
		const again = await session.interactions.press({ selector: "id=go" }).catch((e: unknown) => e);
		expect(again).toMatchObject({ message: expect.stringContaining("E_HID") });
		expect(r.execs.filter((c) => c.includes("shutdown"))).toHaveLength(1);
	});

	test("other failures never reboot the sim", async () => {
		const r = rig(
			() =>
				new FakeDriver({
					screens: [screen()],
					onCall: (call) => (call.method === "tap" ? driverFixtures.failWith("E_IO", "disk") : undefined),
				})
		);
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
		await session.interactions.press({ selector: "id=go" }).catch(() => undefined);
		expect(r.execs).toEqual([]);
	});

	test("a reboot that fails surfaces the original error", async () => {
		const r = rig(
			() =>
				new FakeDriver({
					screens: [screen()],
					onCall: (call) => (call.method === "tap" ? driverFixtures.failWith("E_HID", HID_LOST) : undefined),
				}),
			(cmd) =>
				cmd.includes("shutdown")
					? { exitCode: 1, stdout: "", stderr: "denied" }
					: { exitCode: 0, stdout: "", stderr: "" }
		);
		await using warden = createWardenClient(r.options, r.seams);
		const [lease] = await warden.leases.claim({ platform: "ios" });
		await using session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease> });
		const failure = await session.interactions.press({ selector: "id=go" }).catch((e: unknown) => e);
		expect(failure).toMatchObject({ message: expect.stringContaining("E_HID") });
		expect(r.events.some((e) => e.kind === "warn" && e.message.includes("reboot failed"))).toBe(true);
	});
});

describe("devices.viewer / devices.arrange", () => {
	const darwin = process.platform === "darwin";

	test("viewer reports the running app (pgrep), none when neither runs", async () => {
		const running = new Set<string>(["DeviceHub"]);
		const r = rig(
			() => new FakeDriver({ screens: [screen()] }),
			(cmd) => {
				const name = cmd.split(" ").pop() ?? "";
				return { exitCode: running.has(name) ? 0 : 1, stdout: "", stderr: "" };
			}
		);
		await using warden = createWardenClient(r.options, r.seams);
		expect(await warden.devices.viewer()).toBe(darwin ? "device-hub" : "none");
		running.clear();
		expect(await warden.devices.viewer()).toBe("none");
	});

	test("arrange with no viewer running does nothing", async () => {
		const r = rig(
			() => new FakeDriver({ screens: [screen()] }),
			() => ({ exitCode: 1, stdout: "", stderr: "" })
		);
		await using warden = createWardenClient(r.options, r.seams);
		expect(await warden.devices.arrange()).toEqual({ arranged: [], opened: [], viewer: "none" });
	});
});
