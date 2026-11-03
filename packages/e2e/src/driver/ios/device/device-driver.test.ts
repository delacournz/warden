import { afterEach, describe, expect, test } from "bun:test";
import { canProbeFrontmost, canReadAlertOn } from "../../alerts";
import { el, snapshotOf } from "../../driver.testing";
import type { Driver, DriverResult, Snapshot } from "../../driver.types";
import { driverErr } from "../../errors";
import { collectSpanDetail, type SpanDetail } from "../../span-detail";
import { canPasteText, canSelectAll } from "../../typing";
import { fakeExec } from "../exec.testing";
import type { FakeSimd, FakeSimdReply, FakeSimdRequest } from "../simd.testing";
import { spawnSimd } from "../simd-client";
import { type OpenIosDeviceDriverOptions, openIosDeviceDriver } from "./device-driver";
import type { Devicectl } from "./devicectl";
import { fakeRunner, replayRunner } from "./runner.testing";

const UDID = "00008140-000A0B0C0D0E0F10";
const BUNDLE = "nz.co.delacour.warden.example";
const FOREIGN = "com.apple.mobilesafari";
const SCREEN = { width: 440, height: 956, scale: 3 };

type Handler = (request: FakeSimdRequest) => FakeSimdReply | Promise<FakeSimdReply>;

/** A devicectl that records its calls and answers from `answers`; a call with no answer succeeds with nothing. */
function fakeDevicectl(answers: Partial<Record<keyof Devicectl, unknown>> = {}) {
	const calls: string[] = [];
	const answer =
		(name: keyof Devicectl, fallback: unknown) =>
		async (...args: unknown[]) => {
			calls.push(`${name}${args.length > 0 ? ` ${args.map(String).join(" ")}` : ""}`);
			const given = answers[name];
			if (typeof given === "function") return given(...args);
			return given ?? { success: true, data: fallback };
		};
	const devicectl = {
		install: answer("install", { bundleIds: [BUNDLE] }),
		uninstall: answer("uninstall", undefined),
		isInstalled: answer("isInstalled", true),
		appearance: answer("appearance", "dark"),
		setOrientation: answer("setOrientation", undefined),
		screenshot: answer("screenshot", { png: new Uint8Array([9, 9]) }),
		pasteboardCopy: answer("pasteboardCopy", undefined),
		pasteboardPaste: answer("pasteboardPaste", ""),
	} as unknown as Devicectl;
	return { devicectl, calls };
}

let opened: Driver[] = [];
afterEach(async () => {
	await Promise.all(opened.map((driver) => driver.close()));
	opened = [];
});

async function openWith(runner: FakeSimd, extra: Partial<OpenIosDeviceDriverOptions> = {}) {
	const client = await spawnSimd({ helperPath: "/runner", udid: UDID, spawn: runner.spawn });
	if (!client.success) throw new Error(client.error.message);
	const logs: string[] = [];
	const writes: Array<{ path: string; bytes: Uint8Array }> = [];
	const dc = fakeDevicectl();
	const result = await openIosDeviceDriver({
		udid: UDID,
		exec: fakeExec([]),
		client: client.data,
		bundleId: BUNDLE,
		devicectl: dc.devicectl,
		writeFile: async (path, bytes) => {
			writes.push({ path, bytes });
		},
		log: (line) => logs.push(line),
		...extra,
	});
	if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
	opened.push(result.data);
	return { driver: result.data, runner, logs, writes, dc };
}

const open = (handler: Handler, extra: Partial<OpenIosDeviceDriverOptions> = {}) =>
	openWith(fakeRunner(handler), extra);

const unwrapped = async <T>(promise: DriverResult<T>): Promise<T> => {
	const result = await promise;
	if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.data;
};

const failure = async (promise: DriverResult<unknown>) => {
	const result = await promise;
	if (result.success) throw new Error("expected a failure");
	return result.error;
};

const ok: Handler = () => ({ data: {} });

describe("openIosDeviceDriver", () => {
	test("reports exactly the physical iPhone capabilities", async () => {
		const { driver } = await open(ok);
		expect(driver.platform).toBe("ios");
		expect(driver.id).toBe(UDID);
		expect(driver.capabilities).toEqual({
			pinch: false,
			maxPointers: 0,
			unicodeText: true,
			nativeSettle: false,
			alerts: true,
			reachability: true,
			cheapHitTest: false,
		});
	});

	test("offers no select-all and no paste, so a field fill clears with counted Backspace", async () => {
		const { driver } = await open(ok);
		expect(canSelectAll(driver)).toBe(false);
		expect(canPasteText(driver)).toBe(false);
		expect(canReadAlertOn(driver)).toBe(true);
		expect(canProbeFrontmost(driver)).toBe(true);
	});

	test("without a socket or a client it is E_HELPER_MISSING and names the env var", async () => {
		const result = await openIosDeviceDriver({ udid: UDID, exec: fakeExec([]) });
		expect(!result.success && result.error.code).toBe("E_HELPER_MISSING");
		expect(!result.success && result.error.message).toContain("WARDEN_IOS_RUNNER_SOCKET");
	});

	test("a socket that is not there is E_HELPER_CRASHED or E_HELPER_MISSING, never a hang", async () => {
		const result = await openIosDeviceDriver({
			udid: UDID,
			exec: fakeExec([]),
			socketPath: "/nonexistent/runner.sock",
			defaultTimeoutMs: 200,
		});
		expect(result.success).toBe(false);
	});
});

describe("recorded runner session", () => {
	test("health maps the runner's handshake", async () => {
		const { driver } = await openWith(replayRunner());
		const health = await unwrapped(driver.health());
		expect(health).toMatchObject({ platform: "ios", id: UDID, transport: "xcuitest", bridge: "missing" });
		expect(health.screen).toEqual(SCREEN);
	});

	test("snapshot normalizes a real device tree", async () => {
		const { driver } = await openWith(replayRunner());
		const snap = await unwrapped(driver.snapshot({ interactiveOnly: true }));
		expect(snap).toMatchObject({ platform: "ios", backend: "ax", screen: SCREEN });
		expect(snap.flat.length).toBeGreaterThan(10);
		expect(snap.flat.some((element) => element.identifier === "Settings")).toBe(true);
	});

	test("screenshot decodes the runner's PNG", async () => {
		const { driver } = await openWith(replayRunner());
		const shot = await unwrapped(driver.screenshot());
		expect(shot.png?.slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
	});

	test("orientation reads the device and shows a flat phone as portrait", async () => {
		const { driver } = await openWith(replayRunner());
		expect(await unwrapped(driver.orientation())).toBe("portrait");
	});
});

describe("input", () => {
	test("tap, longPress, swipe and drag send the runner's params and no momentum", async () => {
		const { driver, runner } = await open(ok);
		await unwrapped(driver.tap({ x: 10, y: 20 }, { count: 2, durationMs: 50 }));
		await unwrapped(driver.longPress({ x: 1, y: 2 }, { durationMs: 900 }));
		await unwrapped(driver.swipe({ x: 1, y: 2 }, { x: 3, y: 4 }, { durationMs: 200, momentum: false }));
		await unwrapped(driver.drag({ x: 1, y: 2 }, { x: 3, y: 4 }, { pressMs: 100 }));
		expect(runner.of("tap")[0]).toMatchObject({ x: 10, y: 20, count: 2, durationMs: 50 });
		expect(runner.of("longPress")[0]).toMatchObject({ x: 1, y: 2, durationMs: 900 });
		expect(runner.of("swipe")[0]).toMatchObject({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, durationMs: 200 });
		expect(runner.of("swipe")[0]).not.toHaveProperty("momentum");
		expect(runner.of("drag")[0]).toMatchObject({ pressMs: 100 });
	});

	test("pinch, rotate and gesture are E_UNSUPPORTED without asking the runner", async () => {
		const { driver, runner } = await open(ok);
		for (const call of [
			driver.pinch({ x: 1, y: 1 }, 2),
			driver.rotate({ x: 1, y: 1 }, 90),
			driver.gesture([{ points: [{ x: 1, y: 1 }] }]),
		]) {
			expect((await failure(call)).code).toBe("E_UNSUPPORTED");
		}
		expect(runner.requests.map((request) => request.op)).toEqual([]);
	});

	test("biometrics are E_UNSUPPORTED for every op without asking the runner", async () => {
		const { driver, runner } = await open(ok);
		for (const op of ["status", "enroll", "unenroll", "match", "fail"] as const) {
			const error = await failure(driver.biometrics(op));
			expect(error.code).toBe("E_UNSUPPORTED");
			expect(error.message).toContain("physical iPhone");
		}
		expect(runner.requests.map((request) => request.op)).toEqual([]);
	});

	test("network, location, clock and the device settings are E_UNSUPPORTED without asking the runner", async () => {
		const { driver, runner } = await open(ok);
		for (const call of [
			driver.network({ kind: "offline" }),
			driver.location({ kind: "point", lat: 1, lon: 2 }),
			driver.clock({ kind: "real" }),
			driver.battery(null),
		]) {
			const error = await failure(call);
			expect(error.code).toBe("E_UNSUPPORTED");
			expect(error.message).toContain("physical iPhone");
		}
		expect(runner.requests.map((request) => request.op)).toEqual([]);
	});

	test("shake and back are E_UNSUPPORTED locally; home and volume go to the runner", async () => {
		const { driver, runner } = await open(ok);
		expect((await failure(driver.pressButton("shake"))).code).toBe("E_UNSUPPORTED");
		expect((await failure(driver.pressButton("back"))).code).toBe("E_UNSUPPORTED");
		expect(runner.requests).toHaveLength(0);
		await unwrapped(driver.pressButton("home"));
		await unwrapped(driver.pressButton("volumeUp"));
		expect(runner.of("pressButton").map((request) => request.button)).toEqual(["home", "volumeUp"]);
	});

	test("key sends the HID usage and modifiers", async () => {
		const { driver, runner } = await open(ok);
		await unwrapped(driver.key("Backspace", ["shift"]));
		expect(runner.of("key")[0]).toMatchObject({ usage: 0x2a, modifiers: ["shift"] });
	});

	test("typeText with no focused field surfaces E_NO_ELEMENT", async () => {
		const { driver } = await open(() => ({ error: { code: "E_NO_ELEMENT", message: "no keyboard focus" } }));
		expect((await failure(driver.typeText("hi"))).code).toBe("E_NO_ELEMENT");
	});

	test("a locked phone's fatal code stays E_DEVICE_LOCKED", async () => {
		const { driver } = await open(() => ({ error: { code: "E_DEVICE_LOCKED", message: "Unlock the phone" } }));
		expect((await failure(driver.tap({ x: 1, y: 1 }))).code).toBe("E_DEVICE_LOCKED");
	});
});

describe("reads", () => {
	const tree: Snapshot = snapshotOf(
		[
			el("window", {
				frame: { x: 0, y: 0, width: 440, height: 956 },
				children: [el("button", { id: "login", label: "Log in", frame: { x: 20, y: 100, width: 200, height: 44 } })],
			}),
		],
		{ screen: SCREEN }
	);
	const wire = JSON.parse(JSON.stringify(tree.elements)) as unknown;
	const snapshotReply: Handler = (request) =>
		request.op === "snapshot"
			? { data: { backend: "ax", screen: SCREEN, truncated: false, elements: wire, ms: 5 } }
			: { data: {} };

	test("elementAtPoint is the deepest element of a snapshot at that point, null off every element", async () => {
		const { driver } = await open(snapshotReply);
		const hit = await unwrapped(driver.elementAtPoint({ x: 30, y: 110 }));
		expect(hit?.label).toBe("Log in");
		const window = await unwrapped(driver.elementAtPoint({ x: 400, y: 500 }));
		expect(window?.role).toBe("window");
		expect(await unwrapped(driver.elementAtPoint({ x: 9999, y: 9999 }))).toBeNull();
	});

	test("settle polls snapshot hashes (via hash) and never asks the runner to settle", async () => {
		let now = 0;
		const { driver, runner } = await open(snapshotReply, {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		});
		const notes: SpanDetail = {};
		const outcome = await collectSpanDetail(notes, () => unwrapped(driver.settle({ quietMs: 100, timeoutMs: 2000 })));
		expect(outcome.quiet).toBe(true);
		expect(notes).toEqual({ via: "hash" });
		expect(runner.of("settle")).toHaveLength(0);
		expect(runner.of("snapshot").length).toBeGreaterThanOrEqual(2);
	});

	test("alert and alertOn read alertButtons; isFrontmost asks frontmost", async () => {
		const { driver, runner } = await open((request) => {
			if (request.op === "alertButtons") return { data: null };
			if (request.op === "frontmost") return { data: { frontmost: true } };
			return { data: {} };
		});
		expect(await unwrapped(driver.alert())).toBeNull();
		if (!canReadAlertOn(driver) || !canProbeFrontmost(driver)) throw new Error("capabilities missing");
		expect(await unwrapped(driver.alertOn("axbridge"))).toBeNull();
		expect(await unwrapped(driver.isFrontmost(BUNDLE))).toBe(true);
		expect(runner.of("frontmost")[0]).toMatchObject({ bundleId: BUNDLE });
	});
});

describe("screenshot", () => {
	const PNG = Buffer.from([1, 2, 3, 4]).toString("base64");

	test("with a path the PNG is written there (the runner ignores the path)", async () => {
		const { driver, writes } = await open((request) =>
			request.op === "screenshot" ? { data: { png: PNG } } : ok(request)
		);
		expect(await unwrapped(driver.screenshot({ path: "/out/s.png" }))).toEqual({ path: "/out/s.png" });
		expect(writes).toEqual([{ path: "/out/s.png", bytes: new Uint8Array([1, 2, 3, 4]) }]);
	});

	test("E_UNSUPPORTED from the runner falls back to devicectl", async () => {
		const { driver, dc } = await open((request) =>
			request.op === "screenshot" ? { error: { code: "E_UNSUPPORTED", message: "no" } } : ok(request)
		);
		expect(await unwrapped(driver.screenshot())).toEqual({ png: new Uint8Array([9, 9]) });
		expect(dc.calls).toEqual(["screenshot undefined"]);
	});
});

describe("orientation, appearance, clipboard", () => {
	test("setting an orientation goes through devicectl, then the runner reads it back", async () => {
		const { driver, runner, dc } = await open((request) =>
			request.op === "orientation" ? { data: { orientation: "landscapeLeft", source: "device" } } : ok(request)
		);
		expect(await unwrapped(driver.orientation("landscapeLeft"))).toBe("landscapeLeft");
		expect(dc.calls).toEqual(["setOrientation landscapeLeft"]);
		expect(runner.of("orientation")[0]).not.toHaveProperty("set");
	});

	test("appearance reads through devicectl; setting it is refused (a persistent settings write)", async () => {
		const { driver, dc } = await open(ok);
		expect(await unwrapped(driver.appearance())).toBe("dark");
		const refused = await failure(driver.appearance("light"));
		expect(refused.code).toBe("E_REFUSED");
		expect(dc.calls).toEqual(["appearance"]);
	});

	test("clipboard reads and writes through the device pasteboard, a write is confirmed by reading it back", async () => {
		const runner = fakeRunner(ok);
		const client = await spawnSimd({ helperPath: "/runner", udid: UDID, spawn: runner.spawn });
		if (!client.success) throw new Error("client");
		const dc = fakeDevicectl({ pasteboardPaste: { success: true, data: "hello" } });
		const result = await openIosDeviceDriver({
			udid: UDID,
			exec: fakeExec([]),
			client: client.data,
			devicectl: dc.devicectl,
		});
		if (!result.success) throw new Error("open");
		opened.push(result.data);
		expect(await unwrapped(result.data.clipboard("hello"))).toBe("hello");
		expect((await failure(result.data.clipboard("other"))).code).toBe("E_IO");
		expect(await unwrapped(result.data.clipboard())).toBe("hello");
	});
});

describe("apps", () => {
	test("launch sends args, env and terminateRunning; terminate and openUrl pass through", async () => {
		const { driver, runner } = await open((request) => {
			if (request.op === "launch") return { data: { pid: 0 } };
			if (request.op === "terminate") return { data: { terminated: true } };
			return ok(request);
		});
		await unwrapped(driver.app.launch(BUNDLE, { args: ["-x"], env: { A: "1" }, relaunch: false }));
		await unwrapped(driver.app.terminate(BUNDLE));
		await unwrapped(driver.app.openUrl("myapp://x"));
		expect(runner.of("launch")[0]).toMatchObject({
			bundleId: BUNDLE,
			args: ["-x"],
			env: { A: "1" },
			terminateRunning: false,
		});
		expect(runner.of("terminate")[0]).toMatchObject({ bundleId: BUNDLE });
		expect(runner.of("openUrl")[0]).toMatchObject({ url: "myapp://x" });
	});

	test("isRunning reads appState", async () => {
		const states = ["runningForeground", "runningBackgroundSuspended", "notRunning"];
		const { driver } = await open((request) =>
			request.op === "appState" ? { data: { state: states.shift() } } : ok(request)
		);
		expect(await unwrapped(driver.app.isRunning(BUNDLE))).toBe(true);
		expect(await unwrapped(driver.app.isRunning(BUNDLE))).toBe(true);
		expect(await unwrapped(driver.app.isRunning(BUNDLE))).toBe(false);
	});

	test("install and isInstalled go through devicectl", async () => {
		const { driver, dc } = await open(ok);
		await unwrapped(driver.app.install("/b/App.app"));
		expect(await unwrapped(driver.app.isInstalled(FOREIGN))).toBe(true);
		expect(dc.calls).toEqual(["install /b/App.app", `isInstalled ${FOREIGN}`]);
	});

	test("uninstall of WARDEN_BUNDLE_ID, an owned bundle or one it installed itself is allowed", async () => {
		const { driver, dc } = await open(ok, { ownedBundles: ["com.owned"] });
		await unwrapped(driver.app.uninstall(BUNDLE));
		await unwrapped(driver.app.uninstall("com.owned"));
		await unwrapped(driver.app.install("/b/Other.app"));
		expect(dc.calls.filter((call) => call.startsWith("uninstall"))).toEqual([
			`uninstall ${BUNDLE}`,
			"uninstall com.owned",
		]);
	});

	test("uninstall and clearData of a bundle warden did not install are E_REFUSED and touch nothing", async () => {
		const { driver, dc } = await open(ok, { appPath: "/b/App.app" });
		const uninstall = await failure(driver.app.uninstall(FOREIGN));
		expect(uninstall).toMatchObject({ code: "E_REFUSED", retryable: false });
		expect(uninstall.detail).toEqual({ reason: "physical_protected", bundleId: FOREIGN });
		expect((await failure(driver.app.clearData(FOREIGN))).code).toBe("E_REFUSED");
		expect(dc.calls).toEqual([]);
	});

	test("an app warden installed itself becomes owned for this session", async () => {
		const dc = fakeDevicectl({ install: { success: true, data: { bundleIds: ["com.fresh"] } } });
		const { driver } = await open(ok, { devicectl: dc.devicectl });
		await unwrapped(driver.app.install("/b/Fresh.app"));
		await unwrapped(driver.app.uninstall("com.fresh"));
		expect(dc.calls).toEqual(["install /b/Fresh.app", "uninstall com.fresh"]);
	});

	test("clearData is uninstall then reinstall from the app path, and says the keychain is kept", async () => {
		const { driver, dc } = await open(ok, { appPath: "/b/App.app" });
		const notes: SpanDetail = {};
		await collectSpanDetail(notes, () => unwrapped(driver.app.clearData(BUNDLE, { keychain: true })));
		expect(dc.calls).toEqual([`uninstall ${BUNDLE}`, "install /b/App.app"]);
		expect(notes).toEqual({ keychainKept: true });
	});

	test("clearData without an app path is E_BAD_REQUEST and uninstalls nothing", async () => {
		const { driver, dc } = await open(ok);
		expect((await failure(driver.app.clearData(BUNDLE))).code).toBe("E_BAD_REQUEST");
		expect(dc.calls).toEqual([]);
	});

	test("a failed uninstall during clearData stops before the reinstall", async () => {
		const dc = fakeDevicectl({ uninstall: driverErr("E_IO", "nope") });
		const { driver } = await open(ok, { appPath: "/b/App.app", devicectl: dc.devicectl });
		expect((await failure(driver.app.clearData(BUNDLE))).code).toBe("E_IO");
		expect(dc.calls).toEqual([`uninstall ${BUNDLE}`]);
	});
});
