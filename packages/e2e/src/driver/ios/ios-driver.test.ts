import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { el, snapshotOf } from "../driver.testing";
import type { Driver, Snapshot } from "../driver.types";
import { type ExecCall, fakeExec, joined } from "./exec.testing";
import { KEY_USAGE, type OpenIosDriverOptions, openIosDriver } from "./ios-driver";
import { type FakeSimdReply, type FakeSimdRequest, fakeSimd } from "./simd.testing";

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

	test("no helper anywhere → E_HELPER_MISSING with the doctor hint", async () => {
		const result = await openIosDriver({
			udid: UDID,
			exec: fakeExec([["xcrun", {}]]),
			exists: () => false,
			realpath: (path) => path,
			execPath: "/usr/local/bin/warden",
			importDir: "/repo/packages/e2e/src/driver/ios",
			wardenHome: "/home/.warden",
		});
		expect(!result.success && result.error.code).toBe("E_HELPER_MISSING");
		expect(!result.success && result.error.message).toContain("warden doctor");
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
		expect(helper.of("settle")[0]).toMatchObject({ quietMs: 100, timeoutMs: 1000 });
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
