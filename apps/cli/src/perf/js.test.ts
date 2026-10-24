import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { buildProfile, buildSourceMap, fakeCdp } from "@delacour/warden-perf/js/js.testing";
import { jsOk } from "@delacour/warden-perf/js/js.types";
import { ok } from "@delacour/warden-types/result";
import { type TestContext, testContext } from "../testing";
import { perfJs } from "./js";
import type { JsDeps } from "./js-capture";
import { createSession, updateSession } from "./session";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const T0 = Date.UTC(2026, 9, 24, 10, 0, 0);
const sim = { platform: "ios", id: "U1", name: "warden-iphone-17-1" } as const;
const METRO = "http://127.0.0.1:8081";
const BUNDLE = `${METRO}/index.bundle?platform=ios`;

const profile = buildProfile(
	[
		{ id: 1, name: "(root)", children: [2, 3] },
		{ id: 2, name: "renderFeed", url: BUNDLE, scriptId: "7" },
		{ id: 3, name: "(idle)" },
	],
	[
		[2, 0],
		[2, 300_000],
		[3, 300_000],
		[3, 100_000],
	]
);

function setup(metro: string | null = METRO) {
	const c = testContext([], { now: () => T0 });
	ctx = c;
	asMe(c);
	c.db.recordDevice({ platform: "ios", id: "U1", name: sim.name }, T0);
	const deps = fakePerfDeps([sim], { U1: "com.acme.shop" }, { metro: async () => metro ?? undefined });
	const cdp = fakeCdp(
		{
			"Profiler.stop": { profile },
			"Runtime.evaluate": (params) =>
				String(params?.expression).includes("__DEV__") ? { result: { value: true } } : { result: { value: T0 } },
		},
		{ "Debugger.enable": [{ scriptId: "7", url: BUNDLE, sourceMapURL: `${METRO}/index.map` }] }
	);
	const opened: Array<Parameters<JsDeps["open"]>[0]> = [];
	const slept: number[] = [];
	const js: JsDeps = {
		open: async (o) => {
			opened.push(o);
			return ok({ ...cdp, close: () => undefined });
		},
		fetchMap: async () => jsOk(buildSourceMap(["/work/src/Feed.tsx"], [[[0, 0, 11, 0]]])),
		sleep: async (ms) => {
			slept.push(ms);
		},
	};
	return { c, deps, js, cdp, opened, slept };
}

const run = (s: ReturnType<typeof setup>, opts: Record<string, unknown> = {}) =>
	perfJs(s.c, s.deps, { json: true, app: "com.acme.shop", ...opts }, s.js);

describe("warden perf js", () => {
	test("profiles for --duration, writes the profile and hotspots, reports file:line", async () => {
		const s = setup();
		expect(await run(s, { duration: "5s" })).toBe(0);
		const doc = JSON.parse(s.c.stdout.join("\n"));
		expect(doc).toMatchObject({ ok: true, command: "perf js", result: { app: "com.acme.shop" } });
		expect(s.slept).toEqual([5_000]);
		expect(existsSync(doc.result.files.cpuprofile)).toBe(true);
		expect(doc.result.files.cpuprofile).toContain("/perf/js-");
		expect(doc.result.hotspots.topSelf[0]).toMatchObject({ name: "renderFeed", line: 12, mapped: true });
		expect(doc.result.hotspots.dev).toBe(true);
		expect(JSON.parse(readFileSync(doc.result.files.hotspots, "utf8")).anchor.deviceWallMs).toBe(T0);
	});

	test("default duration is 10s and it attaches to the device's Metro with the app and iOS device name", async () => {
		const s = setup();
		await run(s);
		expect(s.slept).toEqual([10_000]);
		expect(s.opened[0]).toMatchObject({ metroUrl: METRO, appId: "com.acme.shop", deviceName: sim.name });
	});

	test("--metro wins over the lookup", async () => {
		const s = setup(null);
		await run(s, { metro: "http://10.0.0.5:19000/" });
		expect(s.opened[0]?.metroUrl).toBe("http://10.0.0.5:19000");
	});

	test("text mode shows the dev-build banner, the hotspot and next hints", async () => {
		const s = setup();
		expect(await perfJs(s.c, s.deps, { app: "com.acme.shop" }, s.js)).toBe(0);
		const text = s.c.stdout.join("\n");
		expect(text).toContain("dev build (__DEV__)");
		expect(text).toContain("renderFeed");
		expect(text).toContain("src/Feed.tsx:12");
		expect(text).toContain("next:");
	});

	test("no Metro: devtools_unavailable, exit 3", async () => {
		const s = setup(null);
		expect(await run(s)).toBe(3);
		expect(JSON.parse(s.c.stdout.join("\n"))).toMatchObject({ ok: false, error: { code: "devtools_unavailable" } });
	});

	test("Hermes without a Profiler: engine_unavailable naming the method, exit 3", async () => {
		const s = setup();
		const bare = fakeCdp({ "Profiler.start": { __error: "'Profiler.start' wasn't found" } });
		s.js.open = async () => ok({ ...bare, close: () => undefined });
		expect(await run(s)).toBe(3);
		const doc = JSON.parse(s.c.stdout.join("\n"));
		expect(doc.error).toMatchObject({ code: "engine_unavailable" });
		expect(doc.error.message).toContain("Profiler.start");
	});

	test("bad --duration and --sampling-interval are usage errors", async () => {
		const s = setup();
		expect(await run(s, { duration: "soon" })).toBe(1);
		expect(await run(s, { samplingInterval: "0" })).toBe(1);
	});

	test("--duration is capped at 5m", async () => {
		const s = setup();
		await run(s, { duration: "20m" });
		expect(s.slept).toEqual([300_000]);
	});

	test("into a running session: that session's js dir; its collector holding the profiler refuses", async () => {
		const s = setup();
		const made = createSession(s.c, s.deps.session, {
			device: { udid: "U1", platform: "ios", name: sim.name },
			target: { udid: "U1", ownedByCaller: false },
			maxDurationMs: 30_000,
		});
		if (!made.success) throw new Error("create");
		await run(s);
		const doc = JSON.parse(s.c.stdout.join("\n"));
		expect(doc.result.sessionId).toBe(made.data.id);
		expect(doc.result.dir).toContain(`/perf/${made.data.id}/js`);

		updateSession(s.c, made.data.id, (x) => ({
			...x,
			capturers: [{ kind: "js", startedAtIso: "t", state: "running" }],
		}));
		s.c.stdout.length = 0;
		expect(await run(s)).toBe(1);
		expect(JSON.parse(s.c.stdout.join("\n"))).toMatchObject({ ok: false, error: { code: "session_active" } });
	});

	test("observing never takes a lease", async () => {
		const s = setup();
		await run(s);
		expect(s.c.db.listLeases()).toEqual([]);
	});
});
