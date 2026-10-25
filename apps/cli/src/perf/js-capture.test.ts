import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProfile, buildSourceMap, fakeCdp } from "@delacour/warden-perf/js/js.testing";
import { jsOk } from "@delacour/warden-perf/js/js.types";
import {
	CPU_FILE,
	devtoolsPerfError,
	fetchMapCapped,
	HOTSPOTS_FILE,
	jsUiError,
	runJsCapture,
	startJsProfile,
	stopJsProfile,
} from "./js-capture";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
	const d = mkdtempSync(join(tmpdir(), "warden-js-"));
	dirs.push(d);
	return d;
};

const BUNDLE = "http://127.0.0.1:8081/index.bundle?platform=ios";
const profile = buildProfile(
	[
		{ id: 1, name: "(root)", children: [2, 3] },
		{ id: 2, name: "render", url: BUNDLE, scriptId: "7", line: 0, column: 0 },
		{ id: 3, name: "(idle)" },
	],
	[
		[2, 0],
		[2, 200_000],
		[3, 200_000],
		[3, 100_000],
	]
);
const map = buildSourceMap(["/app/src/Feed.tsx"], [[[0, 0, 41, 2]]]);

function profilerCdp() {
	return fakeCdp(
		{
			"Profiler.stop": { profile },
			"Runtime.evaluate": (params) =>
				String(params?.expression).includes("__DEV__")
					? { result: { type: "boolean", value: true } }
					: { result: { type: "number", value: 1_700_000_000_000 } },
		},
		{
			"Debugger.enable": [{ scriptId: "7", url: BUNDLE, sourceMapURL: "http://127.0.0.1:8081/index.map?platform=ios" }],
		}
	);
}

describe("startJsProfile / stopJsProfile", () => {
	test("writes a valid cpuprofile and source-mapped hotspots, with the alignment anchor", async () => {
		const cdp = profilerCdp();
		const started = await startJsProfile(cdp, { samplingIntervalUs: 100, now: () => 5_000 });
		if (!started.success) throw new Error("start");
		expect(started.data.hostWallMs).toBe(5_000);
		expect(started.data.start.deviceWallMs).toBe(1_700_000_000_000);
		expect(started.data.dev).toBe(true);
		const dir = tmp();
		const stopped = await stopJsProfile(started.data, {
			dir,
			metroUrl: "http://127.0.0.1:8081",
			projectRoot: "/app",
			fetchMap: async (url) => {
				expect(url).toBe("http://127.0.0.1:8081/index.map?platform=ios");
				return jsOk(map);
			},
		});
		if (!stopped.success) throw new Error(stopped.error.message);
		const written = JSON.parse(readFileSync(join(dir, CPU_FILE), "utf8"));
		expect(Object.keys(written)).toEqual(
			expect.arrayContaining(["nodes", "startTime", "endTime", "samples", "timeDeltas"])
		);
		const hotspots = JSON.parse(readFileSync(join(dir, HOTSPOTS_FILE), "utf8"));
		expect(hotspots.topSelf[0]).toMatchObject({ name: "render", file: "src/Feed.tsx", line: 42, mapped: true });
		expect(hotspots).toMatchObject({ dev: true, anchor: { hostWallMs: 5_000, deviceWallMs: 1_700_000_000_000 } });
		expect(hotspots.idlePct).toBeGreaterThan(0);
	});

	test("Profiler.start unsupported: typed error, no files", async () => {
		const cdp = fakeCdp({ "Profiler.start": { __error: "'Profiler.start' wasn't found" } });
		const started = await startJsProfile(cdp);
		expect(started).toMatchObject({ success: false, error: { code: "unsupported" } });
		expect(cdp.sent.at(-1)?.method).toBe("Debugger.disable");
	});

	test("a failed Profiler.stop writes nothing", async () => {
		const cdp = fakeCdp({ "Profiler.stop": { __error: "socket closed" } });
		const started = await startJsProfile(cdp);
		if (!started.success) throw new Error("start");
		const dir = tmp();
		const stopped = await stopJsProfile(started.data, { dir, metroUrl: undefined, fetchMap: async () => jsOk("") });
		expect(stopped.success).toBe(false);
		expect(existsSync(join(dir, CPU_FILE))).toBe(false);
	});

	test("with no Metro the profile is written and hotspots say frames are unmapped", async () => {
		const started = await startJsProfile(profilerCdp());
		if (!started.success) throw new Error("start");
		const stopped = await stopJsProfile(started.data, {
			dir: tmp(),
			metroUrl: undefined,
			fetchMap: async () => jsOk(""),
		});
		expect(stopped.success && stopped.data.hotspots.warnings[0]).toContain("not source-mapped");
	});
});

describe("runJsCapture", () => {
	test("start, wait the duration, stop; the collector hook sees the anchor", async () => {
		const cdp = profilerCdp();
		const slept: number[] = [];
		let anchor: number | undefined;
		const result = await runJsCapture(cdp, {
			dir: tmp(),
			metroUrl: "http://127.0.0.1:8081",
			fetchMap: async () => jsOk(map),
			durationMs: 4_000,
			sleep: async (ms) => {
				slept.push(ms);
			},
			onStarted: (c) => {
				anchor = c.start.deviceWallMs;
			},
		});
		expect(result.success).toBe(true);
		expect(slept).toEqual([4_000]);
		expect(anchor).toBe(1_700_000_000_000);
		const order = cdp.sent.map((s) => s.method).filter((m) => m.startsWith("Profiler"));
		expect(order).toEqual([
			"Profiler.enable",
			"Profiler.setSamplingInterval",
			"Profiler.start",
			"Profiler.stop",
			"Profiler.disable",
		]);
	});

	test("an aborted signal still stops and writes what was captured", async () => {
		const ctl = new AbortController();
		const dir = tmp();
		const result = await runJsCapture(profilerCdp(), {
			dir,
			metroUrl: undefined,
			fetchMap: async () => jsOk(""),
			durationMs: 60_000,
			signal: ctl.signal,
			sleep: async (_ms, signal) => {
				ctl.abort();
				expect(signal?.aborted).toBe(true);
			},
		});
		expect(result.success).toBe(true);
		expect(existsSync(join(dir, CPU_FILE))).toBe(true);
	});
});

describe("fetchMapCapped", () => {
	test("reads a body under the cap and refuses one over it", async () => {
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x".repeat(100)) });
		try {
			const url = `http://127.0.0.1:${server.port}/m.map`;
			expect(await fetchMapCapped(url, 1000)).toEqual({ success: true, data: "x".repeat(100) });
			expect(await fetchMapCapped(url, 10)).toMatchObject({ success: false, error: { code: "too_large" } });
		} finally {
			await server.stop(true);
		}
	});

	test("a streamed body past the cap is cut off even without a content-length", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () =>
				new Response(
					new ReadableStream({
						start(controller) {
							for (let i = 0; i < 10; i++) controller.enqueue(new TextEncoder().encode("y".repeat(100)));
							controller.close();
						},
					})
				),
		});
		try {
			const got = await fetchMapCapped(`http://127.0.0.1:${server.port}/`, 250);
			expect(got).toMatchObject({ success: false, error: { code: "too_large" } });
		} finally {
			await server.stop(true);
		}
	});

	test("a redirect is not followed (it could leave Metro's host)", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
		});
		try {
			expect((await fetchMapCapped(`http://127.0.0.1:${server.port}/`, 1000)).success).toBe(false);
		} finally {
			await server.stop(true);
		}
	});

	test("a non-200 answer is a failure", async () => {
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no", { status: 404 }) });
		try {
			expect((await fetchMapCapped(`http://127.0.0.1:${server.port}/`, 1000)).success).toBe(false);
		} finally {
			await server.stop(true);
		}
	});
});

describe("error mapping", () => {
	test("unsupported is engine_unavailable with the hint; others fail", () => {
		expect(jsUiError({ code: "unsupported", message: "x", hint: "h" })).toMatchObject({
			code: "engine_unavailable",
			hint: "h",
			details: { js: "unsupported" },
		});
		expect(jsUiError({ code: "cdp_failed", message: "x" }).code).toBe("failed");
	});

	test("no dev client is devtools_unavailable", () => {
		expect(devtoolsPerfError({ code: "devtools_unavailable", message: "m" }).code).toBe("devtools_unavailable");
		expect(devtoolsPerfError({ code: "cdp_timeout", message: "m" }).code).toBe("failed");
	});
});
