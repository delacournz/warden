import { describe, expect, test } from "bun:test";
import { canProbeFrontmost, canReadAlertOn } from "./alerts";
import { el, failWith, fakeDriver, snapshotOf, unwrap } from "./driver.testing";

const home = snapshotOf([
	el("window", {
		children: [
			el("button", { id: "login", label: "Log in", frame: { x: 20, y: 100, width: 200, height: 44 } }),
			el("textfield", { id: "email", value: "", frame: { x: 20, y: 160, width: 200, height: 44 } }),
		],
	}),
]);
const next = snapshotOf([el("window", { children: [el("text", { label: "Welcome" })] })]);

describe("snapshotOf", () => {
	test("assigns path ids, depth, preorder flat and normFrame", () => {
		const s = snapshotOf([
			el("window", { children: [el("button"), el("list", { children: [el("cell")] })] }),
			el("keyboard"),
		]);
		expect(s.flat.map((e) => e.id)).toEqual(["0", "0.0", "0.1", "0.1.0", "1"]);
		expect(s.flat.map((e) => e.depth)).toEqual([0, 1, 1, 2, 0]);
		expect(s.elements).toHaveLength(2);
		const first = s.flat[0];
		expect(first?.children).toHaveLength(2);
		expect(s.backend).toBe("axbridge");
	});

	test("default rows are stacked; explicit frames are normalised to the screen", () => {
		const s = snapshotOf([el("text"), el("button", { frame: { x: 39, y: 84.4, width: 195, height: 84.4 } })]);
		expect(s.flat[0]?.frame).toEqual({ x: 0, y: 0, width: 390, height: 44 });
		expect(s.flat[1]?.normFrame.x).toBeCloseTo(0.1);
		expect(s.flat[1]?.normFrame.height).toBeCloseTo(0.1);
	});

	test("android platform defaults the uiautomator backend", () => {
		expect(snapshotOf([], { platform: "android" }).backend).toBe("uiautomator");
	});

	test("id maps to identifier; optional fields stay absent", () => {
		const e = snapshotOf([el("button", { id: "x" })]).flat[0];
		expect(e?.identifier).toBe("x");
		expect(e && "label" in e).toBe(false);
	});
});

describe("fakeDriver", () => {
	test("records calls as a discriminated union, in order", async () => {
		const d = fakeDriver({ screens: [home] });
		await d.snapshot({ interactiveOnly: true });
		await d.tap({ x: 1, y: 2 }, { count: 2 });
		await d.swipe({ x: 0, y: 0 }, { x: 0, y: 9 });
		await d.typeText("hi");
		await d.key("Enter", ["shift"]);
		await d.app.launch("com.x", { relaunch: false });
		await d.app.terminate("com.x");
		await d.close();
		expect(d.calls.map((c) => c.method)).toEqual([
			"snapshot",
			"tap",
			"swipe",
			"typeText",
			"key",
			"app.launch",
			"app.terminate",
			"close",
		]);
		expect(d.calls[1]).toEqual({ method: "tap", point: { x: 1, y: 2 }, opts: { count: 2 } });
		expect(d.callsOf("app.launch")[0]?.bundleId).toBe("com.x");
		expect(d.closed).toBe(true);
	});

	test("advance walks the scripted screens and sticks on the last", async () => {
		const d = fakeDriver({ screens: [home, next] });
		expect(unwrap(await d.snapshot())).toBe(home);
		d.advance();
		expect(unwrap(await d.snapshot())).toBe(next);
		d.advance();
		expect(unwrap(await d.snapshot())).toBe(next);
	});

	test("set replaces the current screen; function sources are pinned by set", async () => {
		const d = fakeDriver({ screens: [home] });
		d.set(next);
		expect(unwrap(await d.snapshot())).toBe(next);
		const f = fakeDriver({ screens: () => home });
		expect(unwrap(await f.snapshot())).toBe(home);
		f.set(next);
		expect(unwrap(await f.snapshot())).toBe(next);
	});

	test("onCall can fail or fake a call, after it is recorded", async () => {
		const d = fakeDriver({
			screens: [home],
			onCall: (call) => {
				if (call.method === "tap") return failWith("E_HID", "boom");
				if (call.method === "app.isRunning") return { data: true };
				return undefined;
			},
		});
		const tap = await d.tap({ x: 0, y: 0 });
		expect(!tap.success && tap.error).toMatchObject({ code: "E_HID", message: "boom", retryable: false });
		expect(unwrap(await d.app.isRunning("x"))).toBe(true);
		expect(d.calls).toHaveLength(2);
	});

	test("elementAtPoint hit-tests the smallest element", async () => {
		const d = fakeDriver({ screens: [home] });
		expect(unwrap(await d.elementAtPoint({ x: 30, y: 110 }))?.identifier).toBe("login");
		expect(unwrap(await d.elementAtPoint({ x: 30, y: 170 }))?.identifier).toBe("email");
		expect(unwrap(await d.elementAtPoint({ x: 9999, y: 9999 }))).toBeNull();
	});

	test("stateful defaults: orientation, appearance, clipboard, app lifecycle", async () => {
		const d = fakeDriver({ screens: [home] });
		expect(unwrap(await d.orientation())).toBe("portrait");
		expect(unwrap(await d.orientation("landscapeLeft"))).toBe("landscapeLeft");
		expect(unwrap(await d.orientation())).toBe("landscapeLeft");
		expect(unwrap(await d.appearance("dark"))).toBe("dark");
		expect(unwrap(await d.clipboard("copied"))).toBe("copied");
		expect(unwrap(await d.clipboard())).toBe("copied");
		expect(unwrap(await d.app.isRunning("com.x"))).toBe(false);
		await d.app.launch("com.x");
		expect(unwrap(await d.app.isRunning("com.x"))).toBe(true);
		expect(unwrap(await d.app.isInstalled("com.x"))).toBe(true);
		await d.app.terminate("com.x");
		expect(unwrap(await d.app.isRunning("com.x"))).toBe(false);
	});

	test("biometrics: enrollment is stateful, match and fail leave it alone", async () => {
		const d = fakeDriver({ screens: [home] });
		expect(unwrap(await d.biometrics("status"))).toEqual({ enrolled: false, modality: "face" });
		expect(unwrap(await d.biometrics("enroll")).enrolled).toBe(true);
		expect(unwrap(await d.biometrics("match")).enrolled).toBe(true);
		expect(unwrap(await d.biometrics("unenroll")).enrolled).toBe(false);
		expect(d.calls.filter((c) => c.method === "biometrics")).toHaveLength(4);
	});

	test("health, settle, screenshot and alert defaults", async () => {
		const withAlert = snapshotOf([
			el("alert", {
				label: "Allow notifications?",
				children: [
					el("text", { label: "Allow notifications?" }),
					el("text", { label: "Updates" }),
					el("button", { label: "Allow" }),
					el("button", { label: "Don't Allow" }),
				],
			}),
		]);
		const d = fakeDriver({ screens: [home, withAlert], id: "UDID-1" });
		const health = unwrap(await d.health());
		expect(health).toMatchObject({ platform: "ios", id: "UDID-1" });
		expect(unwrap(await d.settle({ quietMs: 10 }))).toEqual({ quiet: true, waitedMs: 0 });
		expect(unwrap(await d.screenshot({ path: "/tmp/x.png" }))).toEqual({ path: "/tmp/x.png" });
		expect(unwrap(await d.alert())).toBeNull();
		d.advance();
		const alert = unwrap(await d.alert());
		expect(alert?.title).toBe("Allow notifications?");
		expect(alert?.message).toBe("Updates");
		expect(alert?.buttons.map((b) => b.label)).toEqual(["Allow", "Don't Allow"]);
	});

	test("a plain fake has neither optional capability", () => {
		const d = fakeDriver({ screens: [home] });
		expect(canReadAlertOn(d)).toBe(false);
		expect(canProbeFrontmost(d)).toBe(false);
	});

	test("alertBackends offers alertOn: listed readers see the alert, the others none", async () => {
		const sheet = snapshotOf([el("alert", { label: "Title", children: [el("button", { label: "Open" })] })]);
		const d = fakeDriver({ screens: [sheet], alertBackends: ["ax"] });
		if (!canReadAlertOn(d)) throw new Error("alertOn expected");
		expect(unwrap(await d.alertOn("ax"))?.buttons.map((b) => b.label)).toEqual(["Open"]);
		expect(unwrap(await d.alertOn("axbridge"))).toBeNull();
		expect(d.callsOf("alertOn").map((c) => c.backend)).toEqual(["ax", "axbridge"]);
	});

	test("frontmost offers isFrontmost against the app in front now", async () => {
		let front: string | undefined = "com.apple.springboard";
		const d = fakeDriver({ screens: [home], frontmost: () => front });
		if (!canProbeFrontmost(d)) throw new Error("isFrontmost expected");
		expect(unwrap(await d.isFrontmost("com.example.app"))).toBe(false);
		front = "com.example.app";
		expect(unwrap(await d.isFrontmost("com.example.app"))).toBe(true);
		expect(d.callsOf("isFrontmost")).toHaveLength(2);
	});

	test("rotate and gesture are recorded; the fake takes two fingers by default", async () => {
		const d = fakeDriver({ screens: [home] });
		expect(d.capabilities.maxPointers).toBe(2);
		expect((await d.rotate({ x: 1, y: 2 }, 45, { radius: 10 })).success).toBe(true);
		const paths = [
			{
				points: [
					{ x: 0, y: 0 },
					{ x: 5, y: 5 },
				],
			},
		];
		expect((await d.gesture(paths, { durationMs: 100 })).success).toBe(true);
		expect(d.callsOf("rotate")).toEqual([
			{ method: "rotate", center: { x: 1, y: 2 }, degrees: 45, opts: { radius: 10 } },
		]);
		expect(d.callsOf("gesture")).toEqual([{ method: "gesture", paths, opts: { durationMs: 100 } }]);
	});

	test("gesture validates like a real driver", async () => {
		const d = fakeDriver({ screens: [home], capabilities: { maxPointers: 1 } });
		const one = { points: [{ x: 0, y: 0 }] };
		const empty = await d.gesture([]);
		const two = await d.gesture([one, one]);
		expect(empty.success ? "ok" : empty.error.code).toBe("E_BAD_REQUEST");
		expect(two.success ? "ok" : two.error.code).toBe("E_UNSUPPORTED");
		expect(d.callsOf("gesture")).toHaveLength(2);
	});

	test("capabilities can be overridden", () => {
		const d = fakeDriver({ screens: [home], platform: "android", capabilities: { pinch: false } });
		expect(d.platform).toBe("android");
		expect(d.capabilities.pinch).toBe(false);
		expect(d.capabilities.alerts).toBe(true);
	});
});
