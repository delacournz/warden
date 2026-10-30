import { describe, expect, test } from "bun:test";
import { snapshotOf as a11ySnapshot } from "./a11y/a11y.fixture";
import type { A11yEvent } from "./a11y/a11y.types";
import { createDevice } from "./device";
import { fakeDriver } from "./driver/driver.testing";
import type { Platform, Snapshot } from "./driver/driver.types";
import type { E2eEnv } from "./env";
import type { E2eError } from "./errors";
import { createExpect } from "./expect/expect";
import type { FixtureSession } from "./fixture-session";
import { traceDevice } from "./traced-device";

const baseEnv: E2eEnv = {
	udid: "UDID",
	platform: "ios",
	bundleId: "com.example.app",
	launchArgs: [],
	out: "/tmp/out",
	timeoutMs: 1000,
	actionTimeoutMs: 1000,
	assertionTimeoutMs: 200,
	logTimestamps: false,
};

const expectOf = createExpect({ softSink: () => undefined });

/** a screen with one unnamed button (an error) and one named one */
function screenOf(platform: Platform): Snapshot {
	return a11ySnapshot(platform, [
		{
			role: "other",
			frame: { x: 0, y: 0, width: 300, height: 600 },
			children: [
				{
					role: "button",
					identifier: "unnamed",
					traits: platform === "ios" ? ["button"] : ["clickable"],
					frame: { x: 10, y: 10, width: 200, height: 60 },
				},
				{
					role: "button",
					label: platform === "ios" ? "Save" : undefined,
					text: platform === "android" ? "Save" : undefined,
					identifier: "save",
					traits: platform === "ios" ? ["button"] : ["clickable"],
					frame: { x: 10, y: 100, width: 200, height: 60 },
				},
			],
		},
	]);
}

function setup(
	options: {
		platform?: Platform;
		driver?: Partial<Parameters<typeof fakeDriver>[0]>;
		env?: Partial<E2eEnv>;
		screen?: Snapshot;
	} = {}
) {
	const platform = options.platform ?? "ios";
	const driver = fakeDriver({
		screens: [options.screen ?? screenOf(platform)],
		platform,
		...options.driver,
	});
	const session: FixtureSession = { out: "/tmp/out" };
	const device = createDevice({ session, driver, env: { ...baseEnv, platform, ...options.env } });
	return { driver, device };
}

async function failure(promise: Promise<unknown>): Promise<E2eError> {
	try {
		await promise;
	} catch (error) {
		return error as E2eError;
	}
	throw new Error("did not reject");
}

describe("device.a11yAudit", () => {
	test("runs warden's rules and notes the engines it could not use", async () => {
		const { device } = setup();
		const result = await device.a11yAudit();
		expect(result.issues.map((i) => i.rule)).toContain("missing-name");
		expect(result.sources).toEqual(["warden"]);
		expect(result.skipped).toEqual([{ source: "xcuitest", reason: expect.stringContaining("no native") }]);
	});

	test("merges the platform's own findings and its skip reason", async () => {
		const { device, driver } = setup({
			platform: "android",
			driver: {
				auditNatively: () => ({
					issues: [{ rule: "native", severity: "error", source: "atf", identifier: "save", message: "low contrast" }],
				}),
			},
		});
		const result = await device.a11yAudit();
		expect(result.sources).toEqual(["warden", "atf"]);
		expect(result.issues.some((i) => i.source === "atf" && i.message === "low contrast")).toBe(true);
		expect(driver.callsOf("auditNatively")).toEqual([
			{ method: "auditNatively", options: { bundleId: "com.example.app" } },
		]);
		const skipped = await setup({
			driver: { auditNatively: () => ({ issues: [], skipped: { source: "xcuitest", reason: "runner missing" } }) },
		}).device.a11yAudit();
		expect(skipped.skipped).toEqual([{ source: "xcuitest", reason: "runner missing" }]);
	});

	test("{ native: false } and a rules list without native leave the engine alone", async () => {
		const { device, driver } = setup({ driver: { auditNatively: () => ({ issues: [] }) } });
		await device.a11yAudit({ native: false });
		await device.a11yAudit({ rules: ["missing-name"] });
		expect(driver.callsOf("auditNatively")).toEqual([]);
	});

	test("the suite's a11y config is the default and call options win", async () => {
		const env = { a11yAudit: { ignore: [{ rule: "missing-name" as const }], minSeverity: "warning" as const } };
		const { device } = setup({ env });
		const suite = await device.a11yAudit({ native: false });
		expect(suite.issues.map((i) => i.rule)).not.toContain("missing-name");
		const called = await device.a11yAudit({ native: false, ignore: [] });
		expect(called.issues.map((i) => i.rule)).toContain("missing-name");
	});

	test("native findings obey the ignore list", async () => {
		const { device } = setup({
			platform: "android",
			driver: {
				auditNatively: () => ({
					issues: [{ rule: "native", severity: "error", source: "atf", identifier: "save", message: "x" }],
				}),
			},
		});
		const result = await device.a11yAudit({ ignore: [{ rule: "native", identifier: "save" }] });
		expect(result.issues.some((i) => i.source === "atf")).toBe(false);
	});

	test("the iOS injected read is merged into the snapshot first", async () => {
		const { device } = setup({
			driver: {
				readA11y: (shot) => {
					for (const e of shot.flat) if (e.identifier === "unnamed") e.a11y = { important: false };
					return shot;
				},
			},
		});
		const result = await device.a11yAudit();
		expect(result.issues.map((i) => i.rule)).not.toContain("missing-name");
	});
});

describe("device.screenReader", () => {
	test("order() is the simulated reading order and needs no capability", async () => {
		const { device } = setup();
		const order = await device.screenReader.order();
		expect(order.map((a) => a.text)).toContain("Save, button");
		expect(order.every((a) => a.source === "simulated")).toBe(true);
	});

	test("every other call is unsupported without a driver that drives a screen reader, with a TalkBack hint", async () => {
		const { device } = setup();
		for (const call of [
			() => device.screenReader.state(),
			() => device.screenReader.next(),
			() => device.screenReader.prev(),
			() => device.screenReader.activate(),
			() => device.screenReader.focused(),
			() => device.screenReader.spoken(),
		]) {
			const error = await failure(call());
			expect(error.message).toContain("E_UNSUPPORTED");
			expect(error.message).toContain("device.a11y({ screenReader: true })");
		}
	});

	test("with TalkBack the calls reach the driver and focus comes back as an announcement", async () => {
		const screen = screenOf("android");
		const save = screen.flat.find((e) => e.identifier === "save");
		const { device, driver } = setup({
			platform: "android",
			screen,
			driver: {
				screenReader: {
					next: () => save,
					spoken: (since) => ({
						lines: [{ text: "Save, button", at: 3, source: "talkback" }],
						cursor: (since ?? 0) + 1,
					}),
				},
			},
		});
		expect(await device.screenReader.state()).toEqual({ mode: "real", engine: "talkback" });
		const next = await device.screenReader.next();
		expect(next?.text).toContain("Save");
		expect(await device.screenReader.prev()).toBeUndefined();
		await device.screenReader.activate();
		expect(await device.screenReader.spoken({ since: 4 })).toEqual({
			lines: [{ text: "Save, button", at: 3, source: "talkback" }],
			cursor: 5,
		});
		expect(driver.callsOf("screenReaderActivate")).toHaveLength(1);
		expect(driver.callsOf("screenReaderSpoken")).toEqual([{ method: "screenReaderSpoken", since: 4 }]);
	});
});

describe("device.announcements", () => {
	const events: A11yEvent[] = [
		{ kind: "screen-changed", at: 1, source: "uiad" },
		{ kind: "announcement", text: "Saved", at: 2, source: "uiad" },
		{ kind: "live-region", text: "3 items", at: 3, source: "uiad" },
	];

	test("keeps announcements and live regions, and the cursor", async () => {
		const { device, driver } = setup({
			driver: { a11yEvents: (since) => ({ events, cursor: (since ?? 0) + 3 }) },
		});
		expect(await device.announcements({ since: 4 })).toEqual({
			announcements: [
				{ kind: "announcement", text: "Saved", at: 2, source: "uiad" },
				{ kind: "live-region", text: "3 items", at: 3, source: "uiad" },
			],
			cursor: 7,
		});
		expect(driver.callsOf("a11yEvents")).toEqual([{ method: "a11yEvents", since: 4 }]);
	});

	test("a driver that cannot read events is unsupported", async () => {
		const error = await failure(setup().device.announcements());
		expect(error.message).toContain("E_UNSUPPORTED");
	});
});

describe("expect(device)", () => {
	test("toPassA11yAudit fails on errors with the issue table and the --a11y screen", async () => {
		const { device } = setup();
		const error = await failure(expectOf(device).toPassA11yAudit());
		expect(error.code).toBe("ASSERTION");
		expect(error.message).toContain("expect(device).toPassA11yAudit()");
		expect(error.message).toContain("missing-name");
		expect(error.screen).toContain("unnamed");
	});

	test("warnings alone pass by default and fail with minSeverity warning", async () => {
		const small = a11ySnapshot("ios", [
			{
				role: "button",
				label: "Tiny",
				identifier: "tiny",
				traits: ["button"],
				frame: { x: 0, y: 0, width: 20, height: 20 },
			},
		]);
		const { device } = setup({ screen: small });
		await expectOf(device).toPassA11yAudit({ native: false });
		const error = await failure(expectOf(device).toPassA11yAudit({ native: false, minSeverity: "warning" }));
		expect(error.message).toContain("target-size");
	});

	test(".not.toPassA11yAudit passes on a failing screen and fails on a clean one", async () => {
		await expectOf(setup().device).not.toPassA11yAudit();
		const clean = a11ySnapshot("ios", [
			{ role: "button", label: "Save", traits: ["button"], frame: { x: 0, y: 0, width: 200, height: 60 } },
		]);
		const error = await failure(expectOf(setup({ screen: clean }).device).not.toPassA11yAudit());
		expect(error.message).toContain(".not.toPassA11yAudit()");
	});

	test("the traced device is a matcher target too", async () => {
		const { device } = setup();
		const traced = traceDevice(device, (_op, fn) => fn());
		const error = await failure(expectOf(traced).toPassA11yAudit());
		expect(error.code).toBe("ASSERTION");
	});

	test("toHaveAnnounced waits for a matching announcement", async () => {
		let polls = 0;
		const { device } = setup({
			driver: {
				a11yEvents: () => {
					polls += 1;
					return {
						events: polls < 2 ? [] : [{ kind: "announcement", text: "Profile saved", at: 1, source: "uiad" }],
						cursor: polls,
					};
				},
			},
		});
		await expectOf(device).toHaveAnnounced(/saved/i, { timeoutMs: 1000 });
		expect(polls).toBe(2);
	});

	test("toHaveAnnounced times out with the texts it saw, and .not passes then", async () => {
		const { device } = setup({
			driver: {
				a11yEvents: () => ({ events: [{ kind: "announcement", text: "Loading", at: 1, source: "uiad" }], cursor: 1 }),
			},
		});
		const error = await failure(expectOf(device).toHaveAnnounced("Saved", { timeoutMs: 30 }));
		expect(error.code).toBe("ASSERTION");
		expect(error.message).toContain('Received: "Loading"');
		await expectOf(device).not.toHaveAnnounced("Saved", { timeoutMs: 30 });
		const notError = await failure(expectOf(device).not.toHaveAnnounced("Load", { timeoutMs: 30 }));
		expect(notError.message).toContain(".not.toHaveAnnounced");
	});

	test("toHaveAnnounced on a driver without events is a driver error, not a miss", async () => {
		const error = await failure(expectOf(setup().device).toHaveAnnounced("x", { timeoutMs: 10 }));
		expect(error.message).toContain("E_UNSUPPORTED");
	});

	test("an unknown option is rejected", async () => {
		const error = await failure(expectOf(setup().device).toHaveAnnounced("x", { nope: 1 } as never));
		expect(error.code).toBe("INVALID_ARGUMENT");
	});

	test("expect.soft keeps the failure instead of throwing", async () => {
		const kept: E2eError[] = [];
		const soft = createExpect({ softSink: () => (e) => void kept.push(e) }).soft;
		await soft(setup().device).toPassA11yAudit();
		expect(kept).toHaveLength(1);
	});

	test("values that are not a device still go to bun's expect", () => {
		expectOf(3).toBe(3);
	});
});

describe("traceDevice", () => {
	test("spans the a11y calls as device.<call>", async () => {
		const ops: string[] = [];
		const { device } = setup();
		const traced = traceDevice(device, (op, fn) => {
			ops.push(op);
			return fn();
		});
		await traced.a11yAudit({ native: false });
		await traced.screenReader.order();
		await failure(traced.announcements());
		expect(ops).toEqual(["device.a11yAudit", "device.screenReader.order", "device.announcements"]);
	});
});
