import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeExec, type TestContext, testContext } from "../testing";
import { androidFrameRate, FRAMES_FILE, perfFrames } from "./frames";
import { createSession, sessionDir } from "./session";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const fx = (name: string) =>
	readFileSync(join(import.meta.dir, "..", "..", "..", "..", "packages", "perf", "fixtures", name), "utf8");

const T0 = 5_000_000;
const sim = { platform: "ios", id: "U1", name: "warden-iphone-17-1" } as const;
const emu = { platform: "android", id: "emulator-5554", name: "Pixel_8" } as const;
const READ = "adb -s emulator-5554 shell dumpsys gfxinfo com.example.app framestats";
const RESET = "adb -s emulator-5554 shell dumpsys gfxinfo com.example.app reset";

function setup(device: typeof sim | typeof emu, handlers: Array<[string, { stdout?: string; exitCode?: number }]>) {
	const calls: string[][] = [];
	const clock = { now: T0 };
	const c = testContext([], { exec: fakeExec(handlers, calls), now: () => clock.now });
	ctx = c;
	asMe(c);
	c.db.recordDevice({ platform: device.platform, id: device.id, name: device.name }, T0);
	return { c, calls, clock, deps: fakePerfDeps([device]) };
}

const json = (c: TestContext) => JSON.parse(c.stdout.join("\n"));

describe("warden perf frames", () => {
	test("reads gfxinfo as observe: no lease, no reset, report in the envelope", async () => {
		const { c, calls, deps } = setup(emu, [[READ, { stdout: fx("gfxinfo-90hz.txt") }]]);
		expect(await perfFrames(c, deps, { record: true, json: true, app: "com.example.app" })).toBe(0);
		const doc = json(c);
		expect(doc).toMatchObject({
			ok: true,
			command: "perf frames",
			result: { status: "ok", app: "com.example.app", refreshHz: 90, jankPct: 7.88, frozenFrames: 1, reset: false },
		});
		expect(doc.result.findings[0]).toMatchObject({ kind: "jank", severity: "warn" });
		expect(calls.map((x) => x.join(" "))).toEqual([READ]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("--reset runs gfxinfo reset after the read and needs the caller's lease", async () => {
		const { c, calls, deps } = setup(emu, [
			[READ, { stdout: fx("gfxinfo-60hz.txt") }],
			[RESET, { stdout: "" }],
		]);
		expect(await perfFrames(c, deps, { record: true, json: true, app: "com.example.app", reset: true })).toBe(2);
		expect(json(c)).toMatchObject({ ok: false, error: { code: "device_not_leased" } });
		expect(calls).toEqual([]);

		expect(
			await perfFrames(c, deps, { record: true, json: true, app: "com.example.app", reset: true, claim: true })
		).toBe(0);
		const cmds = calls.map((x) => x.join(" "));
		expect(cmds.indexOf(READ)).toBeGreaterThanOrEqual(0);
		expect(cmds.indexOf(RESET)).toBeGreaterThan(cmds.indexOf(READ));
	});

	test("an active session: offsets are session-relative, marks tag windows, frames.json lands in the session dir", async () => {
		const { c, clock, deps } = setup(emu, [[READ, { stdout: fx("gfxinfo-60hz.txt") }]]);
		const made = createSession(c, deps.session, {
			device: { udid: emu.id, platform: "android", name: emu.name },
			target: { udid: emu.id, ownedByCaller: false },
			maxDurationMs: 60_000,
		});
		if (!made.success) throw new Error("create");
		clock.now = T0 + 10_000;
		expect(await perfFrames(c, deps, { record: true, json: true, app: "com.example.app" })).toBe(0);
		const { result } = json(c);
		expect(result.session).toBe(made.data.id);
		expect(result.worstWindows[0].startOffsetMs).toBeLessThanOrEqual(10_000);
		const file = join(sessionDir(c, made.data.id), FRAMES_FILE);
		expect(JSON.parse(readFileSync(file, "utf8")).session).toBe(made.data.id);
	});

	test("no session: nothing is written", async () => {
		const { c, deps } = setup(emu, [[READ, { stdout: fx("gfxinfo-120hz.txt") }]]);
		await perfFrames(c, deps, { record: true, json: true, app: "com.example.app" });
		expect(json(c).result.session).toBeUndefined();
		expect(existsSync(join(sessionDir(c, "x"), FRAMES_FILE))).toBe(false);
	});

	test("app not running: app_not_found with a launch hint", async () => {
		const { c, deps } = setup(emu, [[READ, { stdout: fx("gfxinfo-no-process.txt") }]]);
		expect(await perfFrames(c, deps, { record: true, json: true, app: "com.example.app" })).toBe(1);
		expect(json(c)).toMatchObject({ ok: false, error: { code: "app_not_found" } });
	});

	test("iOS sim: typed unsupported result, no xctrace or simctl frame calls", async () => {
		const { c, calls, deps } = setup(sim, []);
		expect(await perfFrames(c, deps, { record: true, json: true, app: "com.example.app" })).toBe(0);
		const doc = json(c);
		expect(doc.result).toMatchObject({ status: "unsupported", platform: "ios" });
		expect(doc.result.hint).toContain("perf start --native");
		expect(calls).toEqual([]);
	});
});

describe("androidFrameRate", () => {
	test("fps and sample jank % from one read", async () => {
		const { c } = setup(emu, [[READ, { stdout: fx("gfxinfo-60hz.txt") }]]);
		const r = await androidFrameRate(c, emu.id, "com.example.app");
		expect(r?.fps).toBeGreaterThan(30);
		expect(r?.fps).toBeLessThanOrEqual(60);
		expect(r?.jankPct).toBeGreaterThan(0);
	});

	test("failed read or no process: undefined", async () => {
		const { c } = setup(emu, [[READ, { stdout: fx("gfxinfo-no-process.txt") }]]);
		expect(await androidFrameRate(c, emu.id, "com.example.app")).toBeUndefined();
		const bad = setup(emu, [[READ, { exitCode: 1 }]]);
		expect(await androidFrameRate(bad.c, emu.id, "com.example.app")).toBeUndefined();
	});
});
