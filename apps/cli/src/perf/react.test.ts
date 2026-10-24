import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { jsOk } from "@delacour/warden-perf/js/js.types";
import { startReactProfile } from "@delacour/warden-perf/react/profiler";
import { fakeGlobal, fakeHook, fakeRenderer, runtimeCdp } from "@delacour/warden-perf/react/react.testing";
import { ok } from "@delacour/warden-types/result";
import { type TestContext, testContext } from "../testing";
import type { JsDeps } from "./js-capture";
import { perfReact, perfReactStart, perfReactStop } from "./react";
import { createSession } from "./session";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const T0 = Date.UTC(2026, 9, 24, 10, 0, 0);
const sim = { platform: "ios", id: "U1", name: "warden-iphone-17-1" } as const;
const METRO = "http://127.0.0.1:8081";

function setup(globalOver: Record<string, unknown> = {}) {
	const c = testContext([], { now: () => T0 });
	ctx = c;
	asMe(c);
	c.db.recordDevice({ platform: "ios", id: "U1", name: sim.name }, T0);
	const deps = fakePerfDeps([sim], { U1: "com.acme.shop" }, { metro: async () => METRO });
	const renderer = fakeRenderer();
	const g = fakeGlobal(fakeHook([renderer]), globalOver);
	const opened: Array<Parameters<JsDeps["open"]>[0]> = [];
	const slept: number[] = [];
	const js: JsDeps = {
		open: async (o) => {
			opened.push(o);
			return ok({ ...runtimeCdp(g), close: () => undefined });
		},
		fetchMap: async () => jsOk("{}"),
		sleep: async (ms) => {
			slept.push(ms);
		},
	};
	return { c, deps, js, g, renderer, opened, slept };
}

const opts = (o: Record<string, unknown> = {}) => ({ record: true, json: true as const, app: "com.acme.shop", ...o });
const doc = (s: ReturnType<typeof setup>) => JSON.parse(s.c.stdout.join("\n"));

describe("warden perf react", () => {
	test("records for --duration, writes commits and findings, reports the totals", async () => {
		const s = setup();
		expect(await perfReact(s.c, s.deps, opts({ duration: "5s" }), s.js)).toBe(0);
		const out = doc(s);
		expect(out).toMatchObject({
			ok: true,
			command: "perf react",
			result: { app: "com.acme.shop", totals: { commits: 2 } },
		});
		expect(s.slept).toEqual([5_000]);
		expect(s.opened[0]).toMatchObject({ metroUrl: METRO, appId: "com.acme.shop", deviceName: sim.name });
		expect(out.result.dir).toContain("/perf/react-");
		expect(JSON.parse(readFileSync(out.result.files.commits, "utf8")).commits).toHaveLength(2);
		expect(JSON.parse(readFileSync(out.result.files.findings, "utf8")).version).toBe(1);
		expect(s.renderer.calls).toEqual(["start", "stop"]);
	});

	test("default duration 10s, capped at 5m; bad duration is a usage error", async () => {
		const s = setup();
		await perfReact(s.c, s.deps, opts(), s.js);
		await perfReact(s.c, s.deps, opts({ duration: "20m" }), s.js);
		expect(s.slept).toEqual([10_000, 300_000]);
		s.c.stdout.length = 0;
		expect(await perfReact(s.c, s.deps, opts({ duration: "soon" }), s.js)).toBe(1);
	});

	test("text mode: dev banner, the hot commit, next hints", async () => {
		const s = setup();
		expect(await perfReact(s.c, s.deps, { record: true, app: "com.acme.shop" }, s.js)).toBe(0);
		const text = s.c.stdout.join("\n");
		expect(text).toContain("dev build (__DEV__)");
		expect(text).toContain("#0");
		expect(text).toContain("next:");
	});

	test("release build: not_profileable naming the cause", async () => {
		const s = setup({ __DEV__: false });
		expect(await perfReact(s.c, s.deps, opts(), s.js)).toBe(1);
		const out = doc(s);
		expect(out.error).toMatchObject({ code: "not_profileable", details: { react: "release_build" } });
		expect(out.error.message).toContain("release_build");
	});

	test("an empty DevTools backend with no react-devtools-core: engine_unavailable (exit 3)", async () => {
		const s = setup();
		s.g.__REACT_DEVTOOLS_GLOBAL_HOOK__?.rendererInterfaces.clear();
		s.g.__r = Object.assign(() => undefined, { getModules: () => new Map() });
		expect(await perfReact(s.c, s.deps, opts(), s.js)).toBe(3);
		expect(doc(s).error).toMatchObject({ code: "engine_unavailable", details: { react: "devtools_backend_missing" } });
	});

	test("React Native below 0.74: engine_unavailable rn_too_old", async () => {
		const s = setup();
		s.g.__r = Object.assign(
			() => ({ default: { constants: { reactNativeVersion: { major: 0, minor: 72, patch: 5 } } } }),
			{
				getModules: () =>
					new Map([[1, { verboseName: "node_modules/react-native/Libraries/Utilities/Platform.ios.js" }]]),
			}
		);
		expect(await perfReact(s.c, s.deps, opts(), s.js)).toBe(3);
		expect(doc(s).error).toMatchObject({ details: { react: "rn_too_old" } });
	});

	test("no Metro: devtools_unavailable, exit 3", async () => {
		const s = setup();
		s.deps.host.metro = async () => undefined;
		expect(await perfReact(s.c, s.deps, opts(), s.js)).toBe(3);
		expect(doc(s).error.code).toBe("devtools_unavailable");
	});

	test("another agent's live profile: session_active naming the owner; --force takes over", async () => {
		const s = setup();
		await startReactProfile(runtimeCdp(s.g), { owner: "agent:other" });
		expect(await perfReact(s.c, s.deps, opts(), s.js)).toBe(1);
		expect(doc(s).error).toMatchObject({ code: "session_active", details: { owner: "agent:other" } });
		s.c.stdout.length = 0;
		expect(await perfReact(s.c, s.deps, opts({ force: true }), s.js)).toBe(0);
	});

	test("into a running session: that session's react dir", async () => {
		const s = setup();
		const made = createSession(s.c, s.deps.session, {
			device: { udid: "U1", platform: "ios", name: sim.name },
			target: { udid: "U1", ownedByCaller: false },
			maxDurationMs: 30_000,
		});
		if (!made.success) throw new Error("create");
		await perfReact(s.c, s.deps, opts(), s.js);
		const out = doc(s);
		expect(out.result.sessionId).toBe(made.data.id);
		expect(out.result.dir).toContain(`/perf/${made.data.id}/react`);
		expect(existsSync(out.result.files.findings)).toBe(true);
	});

	test("observing never takes a lease", async () => {
		const s = setup();
		await perfReact(s.c, s.deps, opts(), s.js);
		expect(s.c.db.listLeases()).toEqual([]);
	});
});

describe("warden perf react start / stop", () => {
	test("start returns at once; stop, a later invocation, analyses what the runtime recorded", async () => {
		const s = setup();
		expect(await perfReactStart(s.c, s.deps, opts(), s.js)).toBe(0);
		expect(doc(s)).toMatchObject({ ok: true, command: "perf react start", result: { dev: true, bootstrapped: false } });
		expect(s.slept).toEqual([]);
		s.c.stdout.length = 0;
		expect(await perfReactStop(s.c, s.deps, opts(), s.js)).toBe(0);
		expect(doc(s)).toMatchObject({ ok: true, command: "perf react stop", result: { totals: { commits: 2 } } });
	});

	test("stop with nothing running fails; a second agent's start is refused", async () => {
		const s = setup();
		expect(await perfReactStop(s.c, s.deps, opts(), s.js)).toBe(1);
		expect(doc(s).error.message).toContain("no React profile is running");
		s.c.stdout.length = 0;
		await startReactProfile(runtimeCdp(s.g), { owner: "agent:other" });
		expect(await perfReactStart(s.c, s.deps, opts(), s.js)).toBe(1);
		expect(doc(s).error.code).toBe("session_active");
	});
});
