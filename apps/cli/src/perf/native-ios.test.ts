import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "@delacour/warden-core/exec";
import { resetInstrumentCache } from "@delacour/warden-perf/ios/instruments";
import { type TestContext, testContext } from "../testing";
import { createIosNativeProfiler, type IosNativeFs } from "./native-ios";
import type { NativeIo, NativeStartInput } from "./native-types";
import { fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
const dirs: string[] = [];
afterEach(() => {
	ctx?.cleanup();
	resetInstrumentCache();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sim = { platform: "ios", id: "U1", name: "iphone" } as const;
const INSTRUMENTS = "== Standard Instruments ==\nAllocations\nHangs\nLeaks\nTime Profiler\n";
const LAUNCHCTL = "4242\t0\tUIKitApplication:com.acme.shop[0xabc][rb-legacy]\n";

type Rule = [needle: string, reply: Partial<ExecResult>];

function rules(xcode: string, extra: Rule[] = []): Rule[] {
	return [
		...extra,
		["xcodebuild -version", { stdout: `Xcode ${xcode}\nBuild version X\n` }],
		["xctrace list instruments", { stdout: INSTRUMENTS }],
		["launchctl list", { stdout: LAUNCHCTL }],
		["get_app_container", { stdout: "/App/Shop.app\n" }],
		["plutil", { stdout: "Shop\n" }],
		["simctl terminate", {}],
		["simctl launch", { stdout: "com.acme.shop: 5555\n" }],
	];
}

function setup(rs: Rule[], opts: { traceExists?: boolean; recorderDies?: boolean } = {}) {
	const calls: string[] = [];
	const envs: Array<Record<string, string | undefined> | undefined> = [];
	const c = testContext([], {
		now: () => 1_000,
		exec: async (cmd, o) => {
			const line = cmd.join(" ");
			calls.push(line);
			envs.push(o?.env);
			const hit = rs.find(([needle]) => line.includes(needle));
			return hit
				? { exitCode: 0, stdout: "", stderr: "", ...hit[1] }
				: { exitCode: 127, stdout: "", stderr: `no rule ${line}` };
		},
	});
	ctx = c;
	const alive = new Set<number>();
	const spawned: string[][] = [];
	const signals: Array<[number, string]> = [];
	const commands = new Map<number, string>();
	const io: NativeIo = {
		spawnDetached: ({ argv }) => {
			spawned.push(argv);
			if (opts.recorderDies !== true) alive.add(900);
			commands.set(900, argv.join(" "));
			return { pid: 900 };
		},
		kill: (pid, signal) => {
			signals.push([pid, signal]);
			if (signal !== "SIGINT" || stubborn.value === false) alive.delete(pid);
		},
		pidAlive: (pid) => alive.has(pid),
		command: (pid) => commands.get(pid),
		sleep: async () => undefined,
	};
	const stubborn = { value: false };
	const written = new Map<string, string>();
	const fs: IosNativeFs = {
		exists: () => opts.traceExists !== false,
		readText: () => "boom: Failed to attach",
		readChunks: async function* () {},
		remove: () => undefined,
		mkdir: () => undefined,
		writeText: (p, t) => void written.set(p, t),
	};
	const dir = mkdtempSync(join(tmpdir(), "native-ios-"));
	dirs.push(dir);
	return {
		c,
		calls,
		envs,
		io,
		spawned,
		signals,
		alive,
		commands,
		stubborn,
		fs,
		dir,
		written,
		deps: fakePerfDeps([sim]),
	};
}

const target = {
	udid: "U1",
	platform: "ios",
	name: "iphone",
	ownedByCaller: true,
	source: "flag",
	mode: "observe",
} as const;
const input = (dir: string, extra: Partial<NativeStartInput> = {}): NativeStartInput => ({
	target,
	app: "com.acme.shop",
	dir,
	leaks: false,
	maxDurationMs: 20_000,
	...extra,
});

describe("start", () => {
	test("attach: Time Profiler + Hangs on the device, detached", async () => {
		const s = setup(rules("26.3"));
		const res = await createIosNativeProfiler(s.fs).start(s.c, s.deps, s.io, input(s.dir));
		if (!res.success) throw new Error(res.error.message);
		expect(s.spawned[0]?.join(" ")).toBe(
			`xcrun xctrace record --template Time Profiler --instrument Hangs --output ${s.dir}/ios.trace --no-prompt --time-limit 20s --device U1 --attach 4242`
		);
		expect(res.data).toMatchObject({
			pid: 900,
			out: `${s.dir}/ios.trace`,
			startWallMs: 1000,
			state: { allProcesses: false, appPid: 4242 },
		});
	});

	test("Xcode 26.4+ records all processes (no --device)", async () => {
		const s = setup(rules("26.4.1"));
		const res = await createIosNativeProfiler(s.fs).start(s.c, s.deps, s.io, input(s.dir));
		if (!res.success) throw new Error(res.error.message);
		expect(s.spawned[0]).toContain("--all-processes");
		expect(s.spawned[0]).not.toContain("--device");
		expect(res.data.state).toMatchObject({ allProcesses: true, appPid: 4242 });
	});

	test("--leaks cold-launches with MallocStackLogging under the recorder", async () => {
		const s = setup(rules("26.3"));
		const res = await createIosNativeProfiler(s.fs).start(s.c, s.deps, s.io, input(s.dir, { leaks: true }));
		if (!res.success) throw new Error(res.error.message);
		const argv = s.spawned[0]?.join(" ") ?? "";
		expect(argv).toContain("--instrument Hangs --instrument Leaks --instrument Allocations");
		expect(argv).toContain("--device U1 --env MallocStackLogging=1 --launch -- /App/Shop.app");
		expect(s.calls.some((c) => c.includes("simctl terminate U1 com.acme.shop"))).toBe(true);
	});

	test("--leaks on Xcode 26.4+: recorder first, then simctl launch with the child env", async () => {
		const s = setup(rules("27.1"));
		const res = await createIosNativeProfiler(s.fs).start(s.c, s.deps, s.io, input(s.dir, { leaks: true }));
		if (!res.success) throw new Error(res.error.message);
		expect(s.spawned[0]).toContain("--all-processes");
		const i = s.calls.findIndex((c) => c.includes("simctl launch"));
		expect(i).toBeGreaterThan(-1);
		expect(s.envs[i]).toEqual({ SIMCTL_CHILD_MallocStackLogging: "1" });
		expect(res.data.state).toMatchObject({ appPid: 5555, allProcesses: true });
	});

	test("an app that is not running is app_not_found", async () => {
		const s = setup(rules("26.3", [["launchctl list", { stdout: "" }]]));
		const res = await createIosNativeProfiler(s.fs).start(s.c, s.deps, s.io, input(s.dir));
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error.code).toBe("app_not_found");
	});

	test("a missing Hangs instrument fails naming alternatives", async () => {
		const s = setup([["xctrace list instruments", { stdout: "Hitches\nLeaks\n" }], ...rules("26.3")]);
		const res = await createIosNativeProfiler(s.fs).start(s.c, s.deps, s.io, input(s.dir));
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.code).toBe("unsupported");
			expect(res.error.message).toContain("Hitches");
		}
	});

	test("a recorder that dies at once reports its log", async () => {
		const s = setup(rules("26.3"), { recorderDies: true });
		const res = await createIosNativeProfiler(s.fs).start(s.c, s.deps, s.io, input(s.dir));
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error.message).toContain("Failed to attach");
	});
});

describe("stop", () => {
	const handle = (dir: string) => ({ pid: 900, out: `${dir}/ios.trace`, startedAtIso: "x", startWallMs: 1000 });

	test("SIGINT, wait for exit, no SIGKILL", async () => {
		const s = setup(rules("26.3"));
		s.alive.add(900);
		s.commands.set(900, `xctrace record --output ${s.dir}/ios.trace`);
		const res = await createIosNativeProfiler(s.fs).stop(s.c, s.deps, s.io, {
			target,
			app: "a",
			dir: s.dir,
			handle: handle(s.dir),
			analyze: false,
		});
		if (!res.success) throw new Error(res.error.message);
		expect(s.signals).toEqual([[900, "SIGINT"]]);
		expect(res.data.out).toBe(`${s.dir}/ios.trace`);
	});

	test("a reused pid is never signalled", async () => {
		const s = setup(rules("26.3"));
		s.alive.add(900);
		s.commands.set(900, "/usr/bin/some-other-program");
		const res = await createIosNativeProfiler(s.fs).stop(s.c, s.deps, s.io, {
			target,
			app: "a",
			dir: s.dir,
			handle: handle(s.dir),
			analyze: false,
		});
		expect(s.signals).toEqual([]);
		if (res.success) expect(res.data.warnings.join(" ")).toContain("not signalled");
	});

	test("a recorder that ignores SIGINT is killed with a warning", async () => {
		const s = setup(rules("26.3"));
		s.alive.add(900);
		s.stubborn.value = true;
		s.commands.set(900, `xctrace record --output ${s.dir}/ios.trace`);
		const res = await createIosNativeProfiler(s.fs).stop(s.c, s.deps, s.io, {
			target,
			app: "a",
			dir: s.dir,
			handle: handle(s.dir),
			analyze: false,
		});
		expect(s.signals).toEqual([
			[900, "SIGINT"],
			[900, "SIGKILL"],
		]);
		if (res.success) expect(res.data.warnings.join(" ")).toContain("unfinished");
	});

	test("no trace on disk is a failure carrying the xctrace log", async () => {
		const s = setup(rules("26.3"), { traceExists: false });
		const res = await createIosNativeProfiler(s.fs).stop(s.c, s.deps, s.io, {
			target,
			app: "a",
			dir: s.dir,
			handle: handle(s.dir),
			analyze: false,
		});
		expect(res.success).toBe(false);
	});
});

describe("stop with analysis", () => {
	const fx = (name: string) =>
		readFileSync(join(import.meta.dir, "..", "..", "..", "..", "packages", "perf", "fixtures", name), "utf8");

	test("exports toc + tables, filters by the app pid under --all-processes, writes ios-native.json", async () => {
		const s = setup(rules("27.1", [["xctrace export --input", { stdout: fx("xctrace-toc.xml") }]]));
		const files: Record<string, string> = {
			"time-profile.xml": fx("xctrace-time-profile.xml"),
			"potential-hangs.xml": fx("xctrace-hangs.xml"),
			"leaks.xml": fx("xctrace-leaks.xml"),
		};
		const fs: IosNativeFs = {
			...s.fs,
			readChunks: async function* (path) {
				yield files[path.split("/").pop() ?? ""] ?? "";
			},
		};
		const handle = {
			pid: 900,
			out: `${s.dir}/ios.trace`,
			startedAtIso: "x",
			startWallMs: 1000,
			state: { allProcesses: true, appPid: 4242 },
		};
		const res = await createIosNativeProfiler(fs).stop(s.c, s.deps, s.io, {
			target,
			app: "a",
			dir: s.dir,
			handle,
			analyze: true,
		});
		if (!res.success) throw new Error(res.error.message);
		const analysis = res.data.analysis;
		expect(analysis?.findings.map((f) => f.kind)).toEqual(expect.arrayContaining(["native-hotspot", "hang", "leak"]));
		expect(analysis?.files.analysis).toBe(`${s.dir}/ios-native.json`);
		expect(s.written.get(`${s.dir}/ios-native.json`)).toContain('"pid": 4242');
		expect(s.calls.some((c) => c.includes("--output") && c.includes("time-profile.xml"))).toBe(true);
	});
});
