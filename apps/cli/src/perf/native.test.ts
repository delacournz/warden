import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import { ok } from "@delacour/warden-types/result";
import { type TestContext, testContext } from "../testing";
import { type NativeProfilers, perfNative } from "./native";
import { findRunningOneShot, readHandleFile } from "./native-state";
import type { NativeAnalysis, NativeIo, NativeProfiler } from "./native-types";
import { createSession } from "./session";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const T0 = Date.UTC(2026, 9, 24, 10, 0, 0);
const sim = { platform: "ios", id: "U1", name: "iphone" } as const;
const droid = { platform: "android", id: "emulator-5554", name: "pixel" } as const;

const analysis: NativeAnalysis = {
	findings: [
		{
			kind: "native-hotspot",
			severity: "critical",
			costMs: 400,
			evidence: "parseCatalog 40% of samples on Main Thread",
			fix: "cut it",
			next: [],
			thread: "Main Thread",
			function: "parseCatalog",
			selfPct: 40,
		},
	],
	section: { title: "Native (iOS, xctrace)", lines: ["10 samples"] },
	summary: ["native: 1 hotspot"],
	files: { analysis: "/x/ios-native.json" },
	report: { sampleCount: 10 },
	warnings: [],
};

function fakeProfiler(log: string[]): NativeProfiler {
	return {
		start: async (_c, _d, _io, input) => {
			log.push(
				`start ${input.app} leaks=${input.leaks} flavor=${input.flavor ?? "-"} dir=${input.dir.split("/").slice(-2).join("/")}`
			);
			return ok({ pid: 900, out: join(input.dir, "ios.trace"), startedAtIso: "iso", startWallMs: T0 });
		},
		stop: async (_c, _d, _io, input) => {
			log.push(`stop analyze=${input.analyze}`);
			return ok({ out: input.handle.out, ...(input.analyze ? { analysis } : {}), warnings: [] });
		},
		analyze: async (_c, _d, input) => {
			log.push(`analyze ${input.trace}`);
			return ok(analysis);
		},
	};
}

function setup(device: typeof sim | typeof droid = sim) {
	const c = testContext([], { now: () => T0 });
	ctx = c;
	asMe(c);
	c.db.recordDevice({ platform: device.platform, id: device.id, name: device.name }, T0);
	const log: string[] = [];
	const profiler = fakeProfiler(log);
	const profilers: NativeProfilers = { ios: async () => profiler, android: async () => profiler };
	const sleeps: number[] = [];
	const io: NativeIo = {
		spawnDetached: () => ({ pid: 1 }),
		kill: () => undefined,
		pidAlive: () => false,
		sleep: async (ms) => void sleeps.push(ms),
	};
	return { c, log, profilers, io, sleeps, deps: fakePerfDeps([device], { [device.id]: "com.acme.shop" }) };
}

const run = (s: ReturnType<typeof setup>, action: string | undefined, opts: Record<string, unknown> = {}) =>
	perfNative(s.c, s.deps, action, { json: true, app: "com.acme.shop", ...opts }, s.io, s.profilers);

describe("warden perf native", () => {
	test("one-shot: start, wait --duration, stop + analyze, report.md written", async () => {
		const s = setup();
		expect(await run(s, undefined, { duration: "3s" })).toBe(0);
		expect(s.sleeps).toEqual([3000]);
		expect(s.log.map((l) => l.split(" ")[0])).toEqual(["start", "stop"]);
		const doc = JSON.parse(s.c.stdout.join("\n"));
		expect(doc.result.findings[0].kind).toBe("native-hotspot");
		const root = join(wardenHome(s.c.env), "perf");
		const dir: string = doc.result.dir;
		expect(dir).toContain(root);
		expect(readFileSync(join(dir, "..", "report.md"), "utf8")).toContain("parseCatalog");
		expect(JSON.parse(readFileSync(join(dir, "..", "report.json"), "utf8")).native).toEqual({ sampleCount: 10 });
		expect(readHandleFile(dir)?.status).toBe("stopped");
	});

	test("start then stop across invocations via handle.json", async () => {
		const s = setup();
		expect(await run(s, "start")).toBe(0);
		const started = JSON.parse(s.c.stdout.join("\n"));
		expect(started.result).toMatchObject({ action: "start", state: "recording", pid: 900 });
		expect(findRunningOneShot(s.c, "U1")?.file.handle.pid).toBe(900);
		// a second start is refused while one runs
		s.c.stdout.length = 0;
		expect(await run(s, "start")).toBe(1);
		expect(JSON.parse(s.c.stdout.join("\n")).error.code).toBe("session_active");
		s.c.stdout.length = 0;
		expect(await run(s, "stop")).toBe(0);
		expect(s.log.at(-1)).toBe("stop analyze=true");
		expect(findRunningOneShot(s.c, "U1")).toBeUndefined();
	});

	test("stop with nothing running is session_not_found", async () => {
		const s = setup();
		expect(await run(s, "stop")).toBe(1);
		expect(JSON.parse(s.c.stdout.join("\n")).error.code).toBe("session_not_found");
	});

	test("inside a session the recording lands in native/ and is a capturer", async () => {
		const s = setup();
		const made = createSession(s.c, s.deps.session, {
			device: { udid: "U1", platform: "ios" },
			target: { udid: "U1", ownedByCaller: false },
			maxDurationMs: 30_000,
		});
		if (!made.success) throw new Error(made.error.message);
		expect(await run(s, "start")).toBe(0);
		const doc = JSON.parse(s.c.stdout.join("\n"));
		expect(doc.result.sessionId).toBe(made.data.id);
		const sessionJson = JSON.parse(
			readFileSync(join(wardenHome(s.c.env), "perf", made.data.id, "session.json"), "utf8")
		);
		expect(sessionJson.capturers).toContainEqual(
			expect.objectContaining({ kind: "native", pid: 900, state: "running" })
		);
		s.c.stdout.length = 0;
		expect(await run(s, "stop")).toBe(0);
		const after = JSON.parse(readFileSync(join(wardenHome(s.c.env), "perf", made.data.id, "session.json"), "utf8"));
		expect(after.capturers.find((c: { kind: string }) => c.kind === "native").state).toBe("stopped");
		expect(existsSync(join(wardenHome(s.c.env), "perf", made.data.id, "report.md"))).toBe(false);
	});

	test("--leaks mutates: refused without the lease", async () => {
		const s = setup();
		expect(await run(s, "start", { leaks: true })).toBe(2);
		expect(s.log).toEqual([]);
		s.c.stdout.length = 0;
		expect(await run(s, "start", { leaks: true, claim: true })).toBe(0);
		expect(s.log[0]).toContain("leaks=true");
	});

	test("dispatches by platform", async () => {
		const s = setup(droid);
		const seen: string[] = [];
		s.profilers.android = async () => {
			seen.push("android");
			return fakeProfiler(s.log);
		};
		s.profilers.ios = async () => {
			seen.push("ios");
			return fakeProfiler(s.log);
		};
		expect(await run(s, undefined, { duration: "1s", flavor: "simpleperf" })).toBe(0);
		expect(new Set(seen)).toEqual(new Set(["android"]));
		expect(s.log[0]).toContain("flavor=simpleperf");
	});

	test("--analyze re-analyzes a trace without a device", async () => {
		const s = setup();
		expect(await run(s, undefined, { analyze: "/tmp/x/ios.trace" })).toBe(0);
		expect(s.log).toEqual(["analyze /tmp/x/ios.trace"]);
	});

	test("bad action and bad duration are usage errors", async () => {
		const s = setup();
		expect(await run(s, "pause")).toBe(1);
		s.c.stdout.length = 0;
		expect(await run(s, undefined, { duration: "soon" })).toBe(1);
	});
});
