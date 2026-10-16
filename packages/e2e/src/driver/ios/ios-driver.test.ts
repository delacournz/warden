import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canProbeFrontmost, canReadAlertOn } from "../alerts";
import { el, snapshotOf } from "../driver.testing";
import type { Driver, Snapshot } from "../driver.types";
import { type ExecCall, fakeExec, joined } from "./exec.testing";
import { KEY_USAGE, type OpenIosDriverOptions, openIosDriver } from "./ios-driver";
import { type FakeSimdReply, type FakeSimdRequest, fakeSimd } from "./simd.testing";
import { bunSpawn } from "./simd-transport";

const UDID = "UDID-1";
const BUNDLE = "nz.co.delacour.warden.example";
const SCREEN = { width: 390, height: 844, scale: 3 };

const toWire = (snap: Snapshot) => JSON.parse(JSON.stringify(snap.elements)) as unknown;

const home = snapshotOf([
	el("window", {
		children: [
			el("button", { id: "login", label: "Log in", frame: { x: 20, y: 100, width: 200, height: 44 } }),
			el("textfield", { id: "email", value: "", frame: { x: 20, y: 160, width: 200, height: 44 } }),
		],
	}),
]);
const snapshotData = { backend: "axbridge", screen: SCREEN, truncated: false, elements: toWire(home), ms: 25 };

type Handler = (request: FakeSimdRequest) => FakeSimdReply | Promise<FakeSimdReply>;

let opened: Driver[] = [];
afterEach(async () => {
	await Promise.all(opened.map((driver) => driver.close()));
	opened = [];
});

async function open(
	handler: Handler,
	extra: Partial<OpenIosDriverOptions> = {},
	execHandlers: Parameters<typeof fakeExec>[0] = []
) {
	const calls: ExecCall[] = [];
	const helper = fakeSimd(handler);
	const logs: string[] = [];
	const result = await openIosDriver({
		udid: UDID,
		exec: fakeExec([["xcrun simctl spawn UDID-1 defaults", {}], ...execHandlers], calls),
		spawn: helper.spawn,
		helperPath: "/opt/warden-simd",
		exists: () => false,
		log: (line) => logs.push(line),
		...extra,
	});
	if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
	opened.push(result.data);
	return { driver: result.data, helper, calls, logs };
}

const unwrapped = async <T>(
	promise: Promise<{ success: true; data: T } | { success: false; error: { code: string; message: string } }>
) => {
	const result = await promise;
	if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.data;
};

describe("openIosDriver", () => {
	test("spawns the helper with --udid, enables AX automation and reports capabilities from ready", async () => {
		const { driver, helper, calls } = await open(() => ({ data: null }));
		expect(helper.spawns).toEqual([["/opt/warden-simd", "--udid", UDID]]);
		expect(joined(calls)).toContain(
			`xcrun simctl spawn ${UDID} defaults write com.apple.Accessibility AutomationEnabled -bool true`
		);
		expect(driver.platform).toBe("ios");
		expect(driver.id).toBe(UDID);
		expect(driver.capabilities).toMatchObject({ nativeSettle: true, unicodeText: true, alerts: true });
	});

	test("opening costs no xcrun call once the sim's plist has AutomationEnabled", async () => {
		const { calls } = await open(() => ({ data: null }), { devicesRoot: "/devices" }, [
			["plutil -extract AutomationEnabled", { stdout: "true\n" }],
		]);
		expect(joined(calls).filter((line) => line.startsWith("xcrun"))).toEqual([]);
	});

	test("opening writes AutomationEnabled once when the plist lacks it", async () => {
		const { calls } = await open(() => ({ data: null }), { devicesRoot: "/devices" }, [
			["plutil -extract AutomationEnabled", { exitCode: 1, stderr: "no such key" }],
		]);
		expect(joined(calls).filter((line) => line.includes("defaults write"))).toHaveLength(1);
	});

	test("an AutomationEnabled failure is logged, not fatal", async () => {
		const calls: ExecCall[] = [];
		const helper = fakeSimd(() => ({ data: null }));
		const logs2: string[] = [];
		const result = await openIosDriver({
			udid: UDID,
			exec: fakeExec([], calls),
			spawn: helper.spawn,
			helperPath: "/opt/warden-simd",
			log: (line) => logs2.push(line),
		});
		expect(result.success).toBe(true);
		if (result.success) opened.push(result.data);
		expect(logs2.some((line) => line.includes("AX automation"))).toBe(true);
	});

	test("passes --resources when a Resources dir sits next to the helper", async () => {
		const { helper } = await open(() => ({ data: null }), { exists: (path) => path === "/opt/Resources" });
		expect(helper.spawns[0]).toEqual(["/opt/warden-simd", "--udid", UDID, "--resources", "/opt/Resources"]);
	});

	test("locates the helper from env.simd (WARDEN_SIMD)", async () => {
		const { helper } = await open(() => ({ data: null }), {
			helperPath: undefined,
			env: { simd: "/custom/warden-simd" },
			exists: (path) => path === "/custom/warden-simd",
		});
		expect(helper.spawns[0]?.[0]).toBe("/custom/warden-simd");
	});

	test("no helper anywhere → E_HELPER_MISSING with the doctor hint, before any simctl call", async () => {
		const calls: ExecCall[] = [];
		const result = await openIosDriver({
			udid: UDID,
			exec: fakeExec([["xcrun", {}]], calls),
			exists: () => false,
			realpath: (path) => path,
			execPath: "/usr/local/bin/warden",
			importDir: "/repo/packages/e2e/src/driver/ios",
			wardenHome: "/home/.warden",
		});
		expect(!result.success && result.error.code).toBe("E_HELPER_MISSING");
		expect(!result.success && result.error.message).toContain("warden doctor");
		// the AutomationEnabled write (xcrun simctl spawn … defaults write) must not run for a driver that cannot open:
		// on a cold CI mac that call takes seconds and the package's open test timed out on it
		expect(calls).toEqual([]);
	});

	test("a live socket is preferred over spawning", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ios-driver-"));
		const socketPath = join(dir, "simd.sock");
		const seen: string[] = [];
		const ready = `${JSON.stringify({
			event: "ready",
			protocol: 1,
			version: "daemon",
			udid: UDID,
			hid: { transport: "indigo" },
			ax: { default: "axbridge", bridge: "available" },
			screen: SCREEN,
		})}\n`;
		const server = Bun.listen<{ buffer: string }>({
			unix: socketPath,
			socket: {
				open(socket) {
					socket.data = { buffer: "" };
					socket.write(ready);
				},
				data(socket, chunk) {
					socket.data.buffer += new TextDecoder().decode(chunk);
					const lines = socket.data.buffer.split("\n");
					socket.data.buffer = lines.pop() ?? "";
					for (const line of lines) {
						const request = JSON.parse(line) as { id: string; op: string };
						seen.push(request.op);
						socket.write(`${JSON.stringify({ id: request.id, ok: true, data: null })}\n`);
					}
				},
			},
		});
		try {
			const { driver, helper } = await open(() => ({ data: null }), { env: { simdSocket: socketPath } });
			await unwrapped(driver.tap({ x: 1, y: 2 }));
			expect(seen).toEqual(["tap"]);
			expect(helper.spawns).toEqual([]);
			await driver.close();
			expect(seen).toEqual(["tap"]);
		} finally {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a dead socket falls back to spawning on stdio", async () => {
		const { helper, logs } = await open(() => ({ data: null }), { socketPath: "/nonexistent/simd.sock" });
		expect(helper.spawns).toHaveLength(1);
		expect(logs.some((line) => line.includes("spawning a helper on stdio"))).toBe(true);
	});
});

describe("Driver methods over the helper", () => {
	test("health maps the helper payload", async () => {
		const { driver } = await open((request) =>
			request.op === "health"
				? {
						data: {
							version: "1.0.0",
							udid: UDID,
							hid: { transport: "dtuhid" },
							ax: { default: "axbridge", bridge: "available" },
							screen: SCREEN,
						},
					}
				: undefined
		);
		expect(await unwrapped(driver.health())).toEqual({
			platform: "ios",
			id: UDID,
			version: "1.0.0",
			transport: "dtuhid",
			bridge: "available",
			screen: SCREEN,
			detail: { axDefault: "axbridge" },
		});
	});

	test("snapshot sends its options and builds flat, ids, depth and normFrame", async () => {
		const wire = [
			{
				role: "window",
				rawType: "Window",
				frame: { x: 0, y: 0, width: 390, height: 844 },
				children: [
					{ role: "button", rawType: "Button", identifier: "go", frame: { x: 39, y: 84.4, width: 195, height: 84.4 } },
				],
			},
		];
		const { driver, helper } = await open((request) =>
			request.op === "snapshot" ? { data: { ...snapshotData, elements: wire } } : undefined
		);
		const snap = await unwrapped(driver.snapshot({ interactiveOnly: true, backend: "ax" }));
		expect(helper.of("snapshot")[0]).toMatchObject({ interactiveOnly: true, backend: "ax" });
		expect(snap.platform).toBe("ios");
		expect(snap.flat.map((e) => `${e.id}@${e.depth}`)).toEqual(["0@0", "0.0@1"]);
		expect(snap.flat[1]?.normFrame.x).toBeCloseTo(0.1);
		expect(snap.elements[0]?.children[0]?.identifier).toBe("go");
	});

	test("snapshot tolerates D4's extra fields and logs a backend fallback", async () => {
		const { driver, logs } = await open(() => ({
			data: {
				...snapshotData,
				backend: "ax",
				modal: null,
				readMs: 12.5,
				nodes: 3,
				fallback: { from: "axbridge", to: "ax", reason: "applicationUnavailable" },
			},
		}));
		const snap = await unwrapped(driver.snapshot());
		expect(snap.backend).toBe("ax");
		expect("modal" in snap).toBe(false);
		expect(logs.some((line) => line.includes("axbridge -> ax: applicationUnavailable"))).toBe(true);
	});

	test("snapshot without options sends no null params", async () => {
		const { driver, helper } = await open(() => ({ data: snapshotData }));
		await unwrapped(driver.snapshot());
		const request = helper.of("snapshot")[0];
		expect(request && "interactiveOnly" in request).toBe(false);
	});

	test("elementAtPoint: element or null", async () => {
		const { driver, helper } = await open((request) => {
			if (request.op !== "elementAtPoint") return undefined;
			return request.x === 30
				? {
						data: {
							role: "button",
							rawType: "Button",
							identifier: "login",
							frame: { x: 20, y: 100, width: 200, height: 44 },
							hittable: true,
						},
					}
				: { data: null };
		});
		const hit = await unwrapped(driver.elementAtPoint({ x: 30, y: 110 }, { reachability: true }));
		expect(hit).toMatchObject({ identifier: "login", id: "0", depth: 0, enabled: true });
		expect(helper.of("elementAtPoint")[0]).toMatchObject({ x: 30, y: 110, reachability: true });
		expect(await unwrapped(driver.elementAtPoint({ x: 1, y: 1 }))).toBeNull();
	});

	test("tap / longPress / swipe / drag / pinch send flat or structured params", async () => {
		const { driver, helper } = await open(() => ({ data: null }));
		await unwrapped(driver.tap({ x: 10, y: 20 }, { count: 2, durationMs: 50 }));
		await unwrapped(driver.longPress({ x: 11, y: 21 }, { durationMs: 800 }));
		await unwrapped(driver.swipe({ x: 1, y: 2 }, { x: 3, y: 4 }, { durationMs: 400, momentum: false }));
		await unwrapped(driver.drag({ x: 5, y: 6 }, { x: 7, y: 8 }, { pressMs: 300, durationMs: 500, releaseMs: 100 }));
		await unwrapped(driver.pinch({ x: 9, y: 9 }, 2, { durationMs: 600, radius: 80 }));
		expect(helper.requests.map(({ id: _id, timeoutMs: _t, ...rest }) => rest)).toEqual([
			{ op: "tap", x: 10, y: 20, count: 2, durationMs: 50 },
			{ op: "longPress", x: 11, y: 21, durationMs: 800 },
			{ op: "swipe", from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, durationMs: 400, momentum: false },
			{ op: "drag", from: { x: 5, y: 6 }, to: { x: 7, y: 8 }, pressMs: 300, durationMs: 500, releaseMs: 100 },
			{ op: "pinch", center: { x: 9, y: 9 }, scale: 2, durationMs: 600, radius: 80 },
		]);
		const timeouts = helper.requests.map((request) => request.timeoutMs ?? 0);
		expect(timeouts[1]).toBeGreaterThan(800);
		expect(timeouts[3]).toBeGreaterThan(900);
	});

	test("helper errors surface mapped", async () => {
		const { driver } = await open(() => ({ error: { code: "E_HID", message: "indigo send failed" } }));
		const result = await driver.tap({ x: 0, y: 0 });
		expect(!result.success && result.error).toMatchObject({ code: "E_HID", message: "indigo send failed" });
	});

	test("key maps names to HID usages and passes modifiers", async () => {
		const { driver, helper } = await open(() => ({ data: null }));
		await unwrapped(driver.key("Enter"));
		await unwrapped(driver.key("Left", ["shift", "alt"]));
		expect(helper.of("key").map(({ usage, modifiers }) => ({ usage, modifiers }))).toEqual([
			{ usage: KEY_USAGE.Enter, modifiers: undefined },
			{ usage: KEY_USAGE.Left, modifiers: ["shift", "alt"] },
		]);
		expect(KEY_USAGE.Enter).toBe(0x28);
		expect(KEY_USAGE.Up).toBe(0x52);
	});

	test("pressButton maps names; back is unsupported on iOS", async () => {
		const { driver, helper } = await open(() => ({ data: null }));
		await unwrapped(driver.pressButton("home"));
		await unwrapped(driver.pressButton("lock"));
		await unwrapped(driver.pressButton("shake"));
		expect(helper.of("pressButton").map((request) => request.button)).toEqual(["home", "lock", "shake"]);
		const back = await driver.pressButton("back");
		expect(!back.success && back.error.code).toBe("E_UNSUPPORTED");
		expect(helper.of("pressButton")).toHaveLength(3);
	});

	test("orientation reads and sets", async () => {
		let current = "portrait";
		const { driver, helper } = await open((request) => {
			if (request.op !== "orientation") return undefined;
			if (typeof request.set === "string") current = request.set;
			return { data: { orientation: current } };
		});
		expect(await unwrapped(driver.orientation())).toBe("portrait");
		expect(await unwrapped(driver.orientation("landscapeLeft"))).toBe("landscapeLeft");
		expect(helper.of("orientation").map((request) => request.set)).toEqual([undefined, "landscapeLeft"]);
	});

	test("orientation: sources are logged, flat readings are exposed as portrait", async () => {
		const reads = [
			{ orientation: "landscapeLeft", source: "device" },
			{ orientation: "landscapeRight", source: "written" },
			{ orientation: "portrait", source: "assumed" },
			{ orientation: "faceUp", source: "device" },
			{ orientation: "unknown" },
		];
		const { driver, logs } = await open((request) =>
			request.op === "orientation" ? { data: reads.shift() } : undefined
		);
		expect(await unwrapped(driver.orientation())).toBe("landscapeLeft");
		expect(logs.filter((line) => line.includes("orientation"))).toEqual([]);
		expect(await unwrapped(driver.orientation())).toBe("landscapeRight");
		expect(logs.some((line) => line.includes("landscapeRight is written"))).toBe(true);
		expect(await unwrapped(driver.orientation())).toBe("portrait");
		expect(logs.some((line) => line.includes("portrait is assumed"))).toBe(true);
		expect(await unwrapped(driver.orientation())).toBe("portrait");
		expect(await unwrapped(driver.orientation())).toBe("portrait");
		expect(logs.filter((line) => line.includes("exposing it as portrait"))).toHaveLength(2);
	});

	test("health accepts the helper's socket, probe error and build fields", async () => {
		const { driver } = await open((request) =>
			request.op === "health"
				? {
						data: {
							protocol: 1,
							version: "0.1.0",
							udid: UDID,
							hid: { transport: "indigo" },
							ax: { default: "ax", bridge: "failed", error: "guest did not answer" },
							screen: SCREEN,
							idb: "v1.7.2",
							xcode: "26.6",
							state: "Booted",
							uptimeMs: 1234,
							coreSimulatorVersion: null,
							socket: { path: "/h/simd/U.sock", clients: 2 },
						},
					}
				: undefined
		);
		const health = await unwrapped(driver.health());
		expect(health.bridge).toBe("failed");
		expect(health.detail).toMatchObject({
			axDefault: "ax",
			axError: "guest did not answer",
			socket: { path: "/h/simd/U.sock", clients: 2 },
			xcode: "26.6",
			state: "Booted",
		});
	});

	test("health surfaces a degraded bridge as available plus the last read failure in detail", async () => {
		const { driver } = await open((request) =>
			request.op === "health"
				? {
						data: {
							protocol: 1,
							version: "0.1.0",
							udid: UDID,
							hid: { transport: "indigo" },
							ax: {
								default: "axbridge",
								bridge: "degraded",
								lastError: { message: "pid 7 did not respond", agoMs: 1500 },
							},
							screen: SCREEN,
						},
					}
				: undefined
		);
		const health = await unwrapped(driver.health());
		expect(health.bridge).toBe("available");
		expect(health.detail).toMatchObject({
			axBridge: "degraded",
			axLastError: { message: "pid 7 did not respond", agoMs: 1500 },
		});
	});

	test("alert: null, or title/message/buttons with filled ids", async () => {
		let up = false;
		const { driver } = await open((request) =>
			request.op === "alertButtons"
				? {
						data: up
							? {
									title: "Allow notifications?",
									message: "Updates",
									buttons: [
										{
											role: "button",
											rawType: "Button",
											label: "Allow",
											frame: { x: 0, y: 0, width: 100, height: 44 },
										},
										{
											role: "button",
											rawType: "Button",
											label: "Don't Allow",
											frame: { x: 100, y: 0, width: 100, height: 44 },
										},
									],
								}
							: null,
					}
				: undefined
		);
		expect(await unwrapped(driver.alert())).toBeNull();
		up = true;
		const alert = await unwrapped(driver.alert());
		expect(alert?.title).toBe("Allow notifications?");
		expect(alert?.message).toBe("Updates");
		expect(alert?.buttons.map((button) => `${button.id}:${button.label}`)).toEqual(["0:Allow", "1:Don't Allow"]);
	});
});

describe("system alerts through one reader and the frontmost probe", () => {
	const allowButtons = [
		{ role: "button", rawType: "Button", label: "Allow", frame: { x: 0, y: 0, width: 100, height: 44 } },
		{ role: "button", rawType: "Button", label: "Don't Allow", frame: { x: 100, y: 0, width: 100, height: 44 } },
	];

	test("alertOn sends the backend and reads the same payload as alert()", async () => {
		const { driver, helper } = await open((request) =>
			request.op === "alertButtons" ? { data: { title: "Allow?", buttons: allowButtons } } : undefined
		);
		if (!canReadAlertOn(driver)) throw new Error("the iOS driver reads alerts through one backend");
		const alert = await unwrapped(driver.alertOn("ax"));
		expect(alert?.title).toBe("Allow?");
		expect(alert?.buttons.map((button) => button.label)).toEqual(["Allow", "Don't Allow"]);
		expect((await unwrapped(driver.alertOn("axbridge")))?.buttons).toHaveLength(2);
		expect(helper.of("alertButtons").map((request) => request.backend)).toEqual(["ax", "axbridge"]);
	});

	test("alert() still reads both readers (no backend on the wire)", async () => {
		const { driver, helper } = await open((request) => (request.op === "alertButtons" ? { data: null } : undefined));
		expect(await unwrapped(driver.alert())).toBeNull();
		expect(helper.of("alertButtons")[0]).not.toHaveProperty("backend");
	});

	test("alertOn: no alert is null; a modal without readable buttons is an alert with no buttons", async () => {
		let reply: unknown = null;
		const { driver } = await open((request) => (request.op === "alertButtons" ? { data: reply } : undefined));
		if (!canReadAlertOn(driver)) throw new Error("the iOS driver reads alerts through one backend");
		expect(await unwrapped(driver.alertOn("axbridge"))).toBeNull();
		reply = { title: "Open this page in “app”?", buttons: [] };
		expect(await unwrapped(driver.alertOn("axbridge"))).toEqual({ title: "Open this page in “app”?", buttons: [] });
	});

	test("alertOn passes a helper failure on", async () => {
		const { driver } = await open((request) =>
			request.op === "alertButtons"
				? { error: { code: "E_AX_UNAVAILABLE", message: "bridge unavailable", retryable: true } }
				: undefined
		);
		if (!canReadAlertOn(driver)) throw new Error("the iOS driver reads alerts through one backend");
		const result = await driver.alertOn("axbridge");
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("E_AX_UNAVAILABLE");
	});

	test("isFrontmost asks the helper about the bundle and answers its verdict", async () => {
		let frontmost = false;
		const { driver, helper } = await open((request) =>
			request.op === "frontmost" ? { data: { frontmost, pid: 12, frontmostPid: frontmost ? 12 : 3 } } : undefined
		);
		if (!canProbeFrontmost(driver)) throw new Error("the iOS driver probes the frontmost app");
		expect(await unwrapped(driver.isFrontmost(BUNDLE))).toBe(false);
		frontmost = true;
		expect(await unwrapped(driver.isFrontmost(BUNDLE))).toBe(true);
		expect(helper.of("frontmost")[0]).toMatchObject({ bundleId: BUNDLE });
	});

	test("without the AX bridge alertOn('axbridge') reads the host reader and isFrontmost is never asked", async () => {
		const helper = fakeSimd((request) => (request.op === "alertButtons" ? { data: null } : undefined), {
			ready: { ax: { default: "ax", bridge: "missing" } },
		});
		const result = await openIosDriver({
			udid: UDID,
			exec: fakeExec([["xcrun", {}]]),
			spawn: helper.spawn,
			helperPath: "/opt/warden-simd",
			exists: () => false,
		});
		if (!result.success) throw new Error(result.error.message);
		opened.push(result.data);
		const driver = result.data;
		if (!canReadAlertOn(driver) || !canProbeFrontmost(driver)) throw new Error("iOS driver capabilities expected");
		expect(await unwrapped(driver.alertOn("axbridge"))).toBeNull();
		expect(helper.of("alertButtons")[0]).toMatchObject({ backend: "ax" });
		const front = await driver.isFrontmost(BUNDLE);
		expect(!front.success && front.error.code).toBe("E_UNSUPPORTED");
		expect(helper.of("frontmost")).toHaveLength(0);
	});

	test("isFrontmost against a helper without the op is a failure the caller can ignore", async () => {
		const { driver } = await open(() => undefined);
		if (!canProbeFrontmost(driver)) throw new Error("the iOS driver probes the frontmost app");
		const result = await driver.isFrontmost(BUNDLE);
		expect(result.success).toBe(false);
	});
});

describe("typeText", () => {
	test("plain text goes straight to the helper", async () => {
		const { driver, helper, calls } = await open(() => ({ data: null }));
		await unwrapped(driver.typeText("Hello, World 123!"));
		expect(helper.of("typeText")[0]?.text).toBe("Hello, World 123!");
		expect(helper.of("paste")).toHaveLength(0);
		expect(joined(calls).some((line) => line.includes("pbcopy"))).toBe(false);
	});

	test("E_UNSUPPORTED_TEXT pastes the rest through the simulator clipboard", async () => {
		const { driver, helper, calls } = await open(
			(request) =>
				request.op === "typeText"
					? { error: { code: "E_UNSUPPORTED_TEXT", message: "no HID usage for é", detail: { rest: "é and more" } } }
					: { data: null },
			{},
			[["sh -c", {}]]
		);
		await unwrapped(driver.typeText("café and more"));
		const copy = calls.find((call) => call.cmd[0] === "sh");
		expect(copy?.cmd.slice(3)).toEqual(["sh", "é and more", UDID]);
		expect(helper.requests.map((request) => request.op)).toEqual(["typeText", "paste"]);
	});

	test("E_UNSUPPORTED_TEXT without a rest is returned, not guessed", async () => {
		const { driver, helper } = await open((request) =>
			request.op === "typeText" ? { error: { code: "E_UNSUPPORTED_TEXT", message: "no" } } : { data: null }
		);
		const result = await driver.typeText("é");
		expect(!result.success && result.error.code).toBe("E_UNSUPPORTED_TEXT");
		expect(helper.of("paste")).toHaveLength(0);
	});

	test("other errors are not retried through the clipboard", async () => {
		const { driver, helper } = await open(() => ({ error: { code: "E_HID", message: "x" } }));
		const result = await driver.typeText("a");
		expect(!result.success && result.error.code).toBe("E_HID");
		expect(helper.of("paste")).toHaveLength(0);
	});
});

describe("settle", () => {
	test("native settle: params and timeout margin", async () => {
		const { driver, helper } = await open((request) =>
			request.op === "settle" ? { data: { quiet: true, waitedMs: 120 } } : undefined
		);
		expect(await unwrapped(driver.settle({ quietMs: 100, timeoutMs: 1000 }))).toEqual({ quiet: true, waitedMs: 120 });
		// the helper reads settleTimeoutMs; the envelope timeoutMs is the padded client timer
		expect(helper.of("settle")[0]).toMatchObject({ quietMs: 100, settleTimeoutMs: 1000, timeoutMs: 3000 });
	});

	test("a helper that answers too late is a not-quiet outcome, not an error", async () => {
		const { driver } = await open((request) =>
			request.op === "settle" ? { error: { code: "E_TIMEOUT", message: "slow" } } : undefined
		);
		expect(await unwrapped(driver.settle({ timeoutMs: 1000 }))).toEqual({ quiet: false, waitedMs: 3000 });
	});

	test("the first settle after app.launch names the launched bundle, later ones do not", async () => {
		const { driver, helper } = await open(
			(request) => (request.op === "settle" ? { data: { quiet: true, waitedMs: 5 } } : { data: null }),
			{},
			[["xcrun simctl launch", {}]]
		);
		await unwrapped(driver.settle());
		await unwrapped(driver.app.launch(BUNDLE));
		await unwrapped(driver.settle());
		await unwrapped(driver.settle());
		const settles = helper.of("settle");
		expect(settles[0]).not.toHaveProperty("bundleId");
		expect(settles[1]).toMatchObject({ bundleId: BUNDLE });
		expect(settles[2]).not.toHaveProperty("bundleId");
	});

	test("a frontmost_mismatch settle keeps asking for the launched bundle", async () => {
		let answers = 0;
		const { driver, helper } = await open(
			(request) => {
				if (request.op !== "settle") return { data: null };
				answers += 1;
				return {
					data: { quiet: answers > 1, waitedMs: 5, ...(answers === 1 ? { reason: "frontmost_mismatch" } : {}) },
				};
			},
			{},
			[["xcrun simctl launch", {}]]
		);
		await unwrapped(driver.app.launch(BUNDLE));
		expect((await unwrapped(driver.settle())).quiet).toBe(false);
		expect((await unwrapped(driver.settle())).quiet).toBe(true);
		const settles = helper.of("settle");
		expect(settles[0]).toMatchObject({ bundleId: BUNDLE });
		expect(settles[1]).toMatchObject({ bundleId: BUNDLE });
	});

	test("terminating the launched bundle stops naming it", async () => {
		const { driver, helper } = await open(
			(request) => (request.op === "settle" ? { data: { quiet: true, waitedMs: 5 } } : { data: null }),
			{},
			[
				["xcrun simctl launch", {}],
				["xcrun simctl terminate", {}],
			]
		);
		await unwrapped(driver.app.launch(BUNDLE));
		await unwrapped(driver.app.terminate(BUNDLE));
		await unwrapped(driver.settle());
		expect(helper.of("settle")[0]).not.toHaveProperty("bundleId");
	});

	test("E_UNSUPPORTED falls back to snapshot-hash polling, and is remembered", async () => {
		let t = 0;
		const { driver, helper } = await open(
			(request) => {
				if (request.op === "settle")
					return { error: { code: "E_UNSUPPORTED", message: "ax backend has no quiescence" } };
				if (request.op === "snapshot") return { data: snapshotData };
				return undefined;
			},
			{
				now: () => t,
				sleep: async (ms) => {
					t += ms;
				},
			}
		);
		const first = await unwrapped(driver.settle({ quietMs: 100, timeoutMs: 2000 }));
		expect(first.quiet).toBe(true);
		expect(helper.of("settle")).toHaveLength(1);
		const snapshotsAfterFirst = helper.of("snapshot").length;
		expect(snapshotsAfterFirst).toBeGreaterThanOrEqual(3);
		await unwrapped(driver.settle({ quietMs: 100, timeoutMs: 2000 }));
		expect(helper.of("settle")).toHaveLength(1);
	});

	test("a UI that keeps changing times out with quiet:false", async () => {
		let t = 0;
		let n = 0;
		const { driver } = await open(
			(request) => {
				if (request.op === "settle") return { error: { code: "E_UNSUPPORTED", message: "x" } };
				if (request.op === "snapshot") {
					n += 1;
					return { data: { ...snapshotData, elements: toWire(snapshotOf([el("text", { label: `tick ${n}` })])) } };
				}
				return undefined;
			},
			{
				now: () => t,
				sleep: async (ms) => {
					t += ms;
				},
			}
		);
		const result = await unwrapped(driver.settle({ quietMs: 200, timeoutMs: 500 }));
		expect(result.quiet).toBe(false);
	});

	test("snapshot errors during hash polling are returned", async () => {
		const { driver } = await open((request) => {
			if (request.op === "settle") return { error: { code: "E_UNSUPPORTED", message: "x" } };
			return { error: { code: "E_AX_UNAVAILABLE", message: "bridge gone" } };
		});
		const result = await driver.settle({ timeoutMs: 300 });
		expect(!result.success && result.error.code).toBe("E_AX_UNAVAILABLE");
	});

	test("without the AX bridge the helper's settle is never asked", async () => {
		const helper = fakeSimd((request) => (request.op === "snapshot" ? { data: snapshotData } : undefined), {
			ready: { ax: { default: "ax", bridge: "missing" } },
		});
		let t = 0;
		const result = await openIosDriver({
			udid: UDID,
			exec: fakeExec([["xcrun", {}]]),
			spawn: helper.spawn,
			helperPath: "/opt/warden-simd",
			exists: () => false,
			now: () => t,
			sleep: async (ms) => {
				t += ms;
			},
		});
		if (!result.success) throw new Error(result.error.message);
		opened.push(result.data);
		expect(result.data.capabilities.nativeSettle).toBe(false);
		await unwrapped(result.data.settle({ quietMs: 100, timeoutMs: 1000 }));
		expect(helper.of("settle")).toHaveLength(0);
	});
});

describe("screenshot", () => {
	test("with a path the helper writes it", async () => {
		const { driver, helper } = await open(() => ({ data: { path: "/out/a.png" } }));
		expect(await unwrapped(driver.screenshot({ path: "/out/a.png", scale: 0.5 }))).toEqual({ path: "/out/a.png" });
		expect(helper.of("screenshot")[0]).toMatchObject({ path: "/out/a.png", scale: 0.5 });
	});

	test("without a path the base64 PNG is decoded", async () => {
		const bytes = new Uint8Array([137, 80, 78, 71]);
		const { driver } = await open(() => ({ data: { png: Buffer.from(bytes).toString("base64") } }));
		expect(await unwrapped(driver.screenshot())).toEqual({ png: bytes });
	});

	test("falls back to simctl io when the helper op is missing", async () => {
		const { driver, calls, logs } = await open(
			() => ({ error: { code: "E_BAD_REQUEST", message: "unknown op screenshot" } }),
			{},
			[["xcrun simctl io", {}]]
		);
		expect(await unwrapped(driver.screenshot({ path: "/out/b.png" }))).toEqual({ path: "/out/b.png" });
		expect(joined(calls)).toContain(`xcrun simctl io ${UDID} screenshot --type=png /out/b.png`);
		expect(logs.some((line) => line.includes("simctl io"))).toBe(true);
	});

	test("a timeout is not masked by the fallback", async () => {
		const { driver, calls } = await open(() => ({ error: { code: "E_TIMEOUT", message: "slow" } }));
		const result = await driver.screenshot({ path: "/out/c.png" });
		expect(!result.success && result.error.code).toBe("E_TIMEOUT");
		expect(joined(calls).some((line) => line.includes("simctl io"))).toBe(false);
	});
});

describe("simctl-backed methods", () => {
	test("appearance, clipboard and app commands", async () => {
		const { driver, calls } = await open(() => ({ data: null }), {}, [
			["xcrun simctl ui UDID-1 appearance", { stdout: "light\n" }],
			["sh -c", {}],
			["xcrun simctl pbpaste", { stdout: "clip" }],
			["xcrun simctl launch", {}],
			["xcrun simctl terminate", {}],
			["xcrun simctl openurl", {}],
			["xcrun simctl install", {}],
			["xcrun simctl get_app_container", { stdout: "/app\n" }],
			["xcrun simctl uninstall", {}],
			["xcrun simctl spawn UDID-1 launchctl list", { stdout: `7\t0\tUIKitApplication:${BUNDLE}[ab]\n` }],
		]);
		expect(await unwrapped(driver.appearance())).toBe("light");
		expect(await unwrapped(driver.appearance("dark"))).toBe("dark");
		expect(await unwrapped(driver.clipboard("copied"))).toBe("copied");
		expect(await unwrapped(driver.clipboard())).toBe("clip");
		await unwrapped(driver.app.launch(BUNDLE, { args: ["--x"], env: { A: "1" }, relaunch: false }));
		expect(await unwrapped(driver.app.isInstalled(BUNDLE))).toBe(true);
		expect(await unwrapped(driver.app.isRunning(BUNDLE))).toBe(true);
		await unwrapped(driver.app.openUrl("myapp://home"));
		await unwrapped(driver.app.install("/b/App.app"));
		await unwrapped(driver.app.terminate(BUNDLE));
		await unwrapped(driver.app.uninstall(BUNDLE));
		const lines = joined(calls);
		expect(lines).toContain(`xcrun simctl launch ${UDID} ${BUNDLE} --x`);
		expect(lines).toContain(`xcrun simctl openurl ${UDID} myapp://home`);
		expect(lines).toContain(`xcrun simctl install ${UDID} /b/App.app`);
		expect(lines).toContain(`xcrun simctl terminate ${UDID} ${BUNDLE}`);
		expect(lines).toContain(`xcrun simctl uninstall ${UDID} ${BUNDLE}`);
		expect(calls.find((call) => call.cmd.includes("launch"))?.opts?.env).toEqual({ SIMCTL_CHILD_A: "1" });
	});

	test("clearData uses core's resetAppData (missing app is E_APP_UNAVAILABLE)", async () => {
		const { driver } = await open(() => ({ data: null }), {}, [["xcrun simctl get_app_container", { exitCode: 2 }]]);
		const result = await driver.app.clearData(BUNDLE, { keychain: true });
		expect(!result.success && result.error.code).toBe("E_APP_UNAVAILABLE");
	});
});

describe("close", () => {
	test("asks a stdio helper to shut down", async () => {
		const { driver, helper } = await open(() => ({ data: null }));
		await driver.close();
		expect(helper.of("shutdown")).toHaveLength(1);
	});
});

const AX_STALE = { error: { code: "E_AX_UNAVAILABLE", message: "bridge not answering" } } as const;

describe("bridge-stale recovery", () => {
	test("a lone E_AX_UNAVAILABLE goes to the caller; the second in a row restarts the helper and retries", async () => {
		let stale = true;
		const { driver, helper, logs } = await open((request) => {
			if (request.op === "shutdown") {
				stale = false;
				return undefined;
			}
			if (request.op === "snapshot") return stale ? AX_STALE : { data: snapshotData };
			return undefined;
		});
		const first = await driver.snapshot();
		expect(!first.success && first.error).toMatchObject({ code: "E_AX_UNAVAILABLE", retryable: true });
		expect(helper.spawns).toHaveLength(1);

		const second = await unwrapped(driver.snapshot());
		expect(second.flat.length).toBeGreaterThan(0);
		expect(helper.requests.map((request) => request.op)).toEqual(["snapshot", "snapshot", "shutdown", "snapshot"]);
		expect(helper.spawns).toHaveLength(2);
		expect(logs.some((line) => line.includes("AX bridge looks stale"))).toBe(true);
	});

	test("a success or another error in between resets the count", async () => {
		const script: Array<"ax" | "ok" | "timeout"> = ["ax", "ok", "ax", "timeout", "ax"];
		const { driver, helper } = await open((request) => {
			if (request.op !== "snapshot") return undefined;
			const step = script.shift() ?? "ok";
			if (step === "ax") return AX_STALE;
			if (step === "timeout") return { error: { code: "E_TIMEOUT", message: "slow" } };
			return { data: snapshotData };
		});
		for (let call = 0; call < 5; call++) await driver.snapshot();
		expect(helper.of("shutdown")).toHaveLength(0);
		expect(helper.spawns).toHaveLength(1);
	});

	test("if the retry is still stale the error is returned and the restart is not repeated blindly", async () => {
		const { driver, helper } = await open((request) => (request.op === "snapshot" ? AX_STALE : undefined));
		await driver.snapshot();
		const second = await driver.snapshot();
		expect(!second.success && second.error.code).toBe("E_AX_UNAVAILABLE");
		expect(helper.of("snapshot")).toHaveLength(3);
		expect(helper.spawns).toHaveLength(2);
		await driver.snapshot();
		expect(helper.spawns).toHaveLength(2);
	});

	test("settle's hash polling gets the same recovery", async () => {
		let stale = true;
		let t = 0;
		const { driver, helper } = await open(
			(request) => {
				if (request.op === "settle") return { error: { code: "E_UNSUPPORTED", message: "x" } };
				if (request.op === "shutdown") {
					stale = false;
					return undefined;
				}
				if (request.op === "snapshot") return stale ? AX_STALE : { data: snapshotData };
				return undefined;
			},
			{
				now: () => t,
				sleep: async (ms) => {
					t += ms;
				},
			}
		);
		const first = await driver.settle({ quietMs: 100, timeoutMs: 1000 });
		expect(!first.success && first.error.code).toBe("E_AX_UNAVAILABLE");
		const second = await unwrapped(driver.settle({ quietMs: 100, timeoutMs: 1000 }));
		expect(second.quiet).toBe(true);
		expect(helper.spawns).toHaveLength(2);
	});

	test("socket mode: shuts the daemon down and reconnects, falling back to a stdio spawn when it is gone", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ios-driver-"));
		const socketPath = join(dir, "simd.sock");
		const ready = `${JSON.stringify({
			event: "ready",
			protocol: 1,
			version: "daemon",
			udid: UDID,
			hid: { transport: "indigo" },
			ax: { default: "axbridge", bridge: "available" },
			screen: SCREEN,
		})}\n`;
		const seen: string[] = [];
		const server = Bun.listen<{ buffer: string }>({
			unix: socketPath,
			socket: {
				open(socket) {
					socket.data = { buffer: "" };
					socket.write(ready);
				},
				data(socket, chunk) {
					socket.data.buffer += new TextDecoder().decode(chunk);
					const lines = socket.data.buffer.split("\n");
					socket.data.buffer = lines.pop() ?? "";
					for (const line of lines) {
						const request = JSON.parse(line) as { id: string; op: string };
						seen.push(request.op);
						if (request.op === "snapshot") {
							socket.write(`${JSON.stringify({ id: request.id, ok: false, error: AX_STALE.error })}\n`);
						} else {
							if (request.op === "shutdown") server.stop();
							socket.write(`${JSON.stringify({ id: request.id, ok: true, data: null })}\n`);
						}
					}
				},
			},
		});
		try {
			const { driver, helper } = await open(
				(request) => (request.op === "snapshot" ? { data: snapshotData } : undefined),
				{
					env: { simdSocket: socketPath },
				}
			);
			await driver.snapshot();
			const recovered = await unwrapped(driver.snapshot());
			expect(recovered.flat.length).toBeGreaterThan(0);
			expect(seen).toEqual(["snapshot", "snapshot", "shutdown"]);
			expect(helper.spawns).toHaveLength(1);
		} finally {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("helper crash (real fake-simd process)", () => {
	const FAKE = join(import.meta.dir, "../../../native/scripts/fake-simd.ts");

	test("one E_HELPER_CRASHED surfaces, the next call succeeds on a respawned helper", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ios-driver-crash-"));
		const script = join(dir, "script.json");
		writeFileSync(
			script,
			JSON.stringify({ dieAfter: { requests: 2, once: true, exitCode: 9 }, ops: { tap: { data: null } } })
		);
		try {
			const { driver } = await open(() => undefined, {
				spawn: (cmd) => bunSpawn([process.execPath, FAKE, "--script", script, ...cmd.slice(1)]),
			});
			expect((await driver.tap({ x: 1, y: 1 })).success).toBe(true);
			const crashed = await driver.tap({ x: 1, y: 1 });
			expect(!crashed.success && crashed.error).toMatchObject({ code: "E_HELPER_CRASHED", retryable: true });
			expect((await driver.tap({ x: 1, y: 1 })).success).toBe(true);
			expect((await driver.tap({ x: 1, y: 1 })).success).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("latency log (WARDEN_E2E_DEBUG)", () => {
	test("debug logs each helper op and simctl call with its duration", async () => {
		let t = 0;
		const { driver, logs } = await open(
			(request) => (request.op === "tap" ? { error: { code: "E_HID", message: "x" } } : { data: null }),
			{
				debug: true,
				now: () => {
					t += 7;
					return t;
				},
			},
			[["xcrun simctl terminate", {}]]
		);
		await driver.tap({ x: 1, y: 2 });
		await driver.pressButton("home");
		await driver.app.terminate(BUNDLE);
		expect(logs).toContain("[ios] op tap 7 ms E_HID");
		expect(logs).toContain("[ios] op pressButton 7 ms");
		expect(logs).toContain("[ios] exec xcrun simctl terminate 7 ms (exit 0)");
		expect(logs.some((line) => line.startsWith("[ios] exec xcrun simctl spawn"))).toBe(true);
	});

	test("without debug only the usual lines are logged", async () => {
		const { driver, logs } = await open(() => ({ data: null }));
		await driver.tap({ x: 1, y: 2 });
		expect(logs.some((line) => line.startsWith("[ios] op "))).toBe(false);
		expect(logs.some((line) => line.startsWith("[ios] exec "))).toBe(false);
	});
});
