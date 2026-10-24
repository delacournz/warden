import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeSamples } from "@delacour/warden-perf/metrics/series";
import { scriptedUi, type TestContext, testContext } from "../testing";
import { perfMetrics } from "./metrics";
import type { MetricsIo } from "./metrics-watch";
import { createSession, updateSession } from "./session";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const T0 = 5_000_000;
const APP = "nz.co.x";
const droid = { platform: "android", id: "emulator-5554", name: "warden-pixel-1" } as const;

/** `dumpsys meminfo` reduced to the lines the parser needs, with the given PSS. */
const meminfo = (pssKb: number): string =>
	`** MEMINFO in pid 4321 [${APP}] **\n App Summary\n                       Pss(KB)\n                        ------\n           Java Heap:    1000\n\n           TOTAL PSS:   ${pssKb}            TOTAL RSS:   ${pssKb + 1000}       TOTAL SWAP PSS:     0\n`;

type Opts = { pss?: (tick: number) => number; running?: () => boolean; rich?: boolean };

function setup(opts: Opts = {}) {
	const clock = { now: T0 };
	let tick = 0;
	const calls: string[] = [];
	const c = testContext([], {
		now: () => clock.now,
		ui: scriptedUi({ rich: opts.rich ?? false }),
		exec: async (cmd) => {
			const joined = cmd.join(" ");
			calls.push(joined);
			if (opts.running?.() === false) return { exitCode: 0, stdout: "", stderr: "" };
			if (joined.includes("pidof")) return { exitCode: 0, stdout: "4321\n", stderr: "" };
			if (joined.includes("shell top")) {
				return { exitCode: 0, stdout: " 4321 u0_a1 10 -10 14G 250M 120M S  25.0 6.5 0:30.11 nz.co.x\n", stderr: "" };
			}
			if (joined.includes("dumpsys meminfo")) {
				tick++;
				return { exitCode: 0, stdout: meminfo(opts.pss?.(tick) ?? 200_000), stderr: "" };
			}
			return { exitCode: 1, stdout: "", stderr: "" };
		},
	});
	ctx = c;
	asMe(c);
	c.db.recordDevice(droid, T0);
	const controller = new AbortController();
	const writes: string[] = [];
	const io: MetricsIo = {
		signal: controller.signal,
		sleep: async (ms) => {
			clock.now += ms;
		},
		write: (chunk) => writes.push(chunk),
	};
	return { c, clock, deps: fakePerfDeps([droid]), io, controller, writes, calls };
}

const json = (c: TestContext) => JSON.parse(c.stdout[c.stdout.length - 1] ?? "null");

describe("warden perf metrics (one-shot)", () => {
	test("samples for 3s at 1s: 4 readings, a summary, and a one-shot samples.jsonl", async () => {
		const { c, deps, io } = setup();
		expect(await perfMetrics(c, deps, { app: APP, record: true, json: true }, io)).toBe(0);
		const doc = json(c);
		expect(doc).toMatchObject({ ok: true, command: "perf metrics", result: { app: APP, intervalMs: 1000 } });
		expect(doc.result.summary.count).toBe(4);
		expect(doc.result.summary.cpuPct.avg).toBe(25);
		expect(doc.result.summary.pssKb.max).toBe(200_000);
		const rows = decodeSamples(readFileSync(doc.result.samples, "utf8"));
		expect(rows.map((r) => r.atMs)).toEqual([0, 1000, 2000, 3000]);
		expect(doc.result.samples).toContain(join("perf", "metrics-"));
		expect(doc.warnings?.[0]).toContain("compare relative");
	});

	test("text mode: figures per metric, where the samples went, next:", async () => {
		const { c, deps, io } = setup();
		expect(await perfMetrics(c, deps, { app: APP, record: true }, io)).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).toContain(`${APP} on warden-pixel-1 (android): 4 samples over 3.0s`);
		expect(text).toMatch(/cpu\s+min 25\.0\s+avg 25\.0\s+p95 25\.0\s+max 25\.0 %/);
		expect(text).toMatch(/pss\s+min 195\.3/);
		expect(text).toContain("samples: ");
		expect(text).toContain("next: warden perf memory --snapshot");
		expect(text.split("\n").length).toBeLessThanOrEqual(40);
	});

	test("--interval/--duration are honoured", async () => {
		const { c, deps, io } = setup();
		await perfMetrics(c, deps, { app: APP, record: true, json: true, interval: "500ms", duration: "2s" }, io);
		expect(json(c).result.summary.count).toBe(5);
	});

	test("a steadily climbing PSS surfaces the memory-growth finding", async () => {
		const { c, deps, io } = setup({ pss: (t) => 100_000 + t * 600 });
		await perfMetrics(c, deps, { app: APP, record: true, json: true, duration: "10s" }, io);
		const doc = json(c);
		expect(doc.result.findings[0]).toMatchObject({ kind: "memory-growth", severity: "warn" });
	});

	test.each([
		[{ interval: "fast" }, "--interval"],
		[{ interval: "100ms" }, "at least 200ms"],
		[{ duration: "0" }, "--duration"],
	])("bad flags %p: usage error", async (flags, fragment) => {
		const { c, deps, io } = setup();
		expect(await perfMetrics(c, deps, { app: APP, record: true, json: true, ...flags }, io)).toBe(1);
		const doc = json(c);
		expect(doc).toMatchObject({ ok: false, error: { code: "usage" } });
		expect(doc.error.message).toContain(fragment);
	});

	test("the app not running: app_not_found, exit 1", async () => {
		const { c, deps, io } = setup({ running: () => false });
		expect(await perfMetrics(c, deps, { app: APP, record: true, json: true }, io)).toBe(1);
		expect(json(c)).toMatchObject({ ok: false, error: { code: "app_not_found" } });
	});

	test("the app dying mid-series keeps what was sampled and says so", async () => {
		let up = true;
		const { c, deps, io } = setup({ running: () => up });
		const sleep = io.sleep;
		let sleeps = 0;
		io.sleep = async (ms, signal) => {
			await sleep(ms, signal);
			if (++sleeps === 2) up = false;
		};
		expect(await perfMetrics(c, deps, { app: APP, record: true, json: true }, io)).toBe(0);
		const doc = json(c);
		expect(doc.result.summary.count).toBe(2);
		expect(doc.warnings.join(" ")).toContain("sampling stopped early");
	});

	test("never takes a lease", async () => {
		const { c, deps, io } = setup();
		await perfMetrics(c, deps, { app: APP, record: true, json: true }, io);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("an active session gets the series in its own metrics/samples.jsonl, timed from the session start", async () => {
		const { c, clock, deps, io } = setup();
		const made = createSession(c, deps.session, {
			device: { udid: droid.id, platform: "android", name: droid.name },
			target: { udid: droid.id, ownedByCaller: false },
			maxDurationMs: 60_000,
		});
		if (!made.success) throw new Error("create");
		clock.now = T0 + 2_000;
		await perfMetrics(c, deps, { app: APP, record: true, json: true, duration: "1s" }, io);
		const doc = json(c);
		expect(doc.result.sessionId).toBe(made.data.id);
		expect(doc.result.samples).toBe(join(c.env.WARDEN_HOME ?? "", "perf", made.data.id, "metrics", "samples.jsonl"));
		expect(decodeSamples(readFileSync(doc.result.samples, "utf8")).map((r) => r.atMs)).toEqual([2000, 3000]);
	});

	test("while the session's collector samples metrics, a hand-run writes samples-manual.jsonl instead", async () => {
		const { c, deps, io } = setup();
		const made = createSession(c, deps.session, {
			device: { udid: droid.id, platform: "android", name: droid.name },
			target: { udid: droid.id, ownedByCaller: false },
			maxDurationMs: 60_000,
		});
		if (!made.success) throw new Error("create");
		updateSession(c, made.data.id, (s) => ({
			...s,
			capturers: [{ kind: "metrics", startedAtIso: "x", state: "running" }],
		}));
		await perfMetrics(c, deps, { app: APP, record: true, json: true, duration: "1s" }, io);
		const dir = join(c.env.WARDEN_HOME ?? "", "perf", made.data.id, "metrics");
		expect(readdirSync(dir)).toEqual(["samples-manual.jsonl"]);
	});

	test("one-shot dirs are not sessions", async () => {
		const { c, deps, io } = setup();
		await perfMetrics(c, deps, { app: APP, record: true, json: true }, io);
		const root = join(c.env.WARDEN_HOME ?? "", "perf");
		expect(existsSync(root)).toBe(true);
		expect(readdirSync(root).every((n) => n.startsWith("metrics-"))).toBe(true);
	});
});

describe("warden perf metrics --watch", () => {
	test("piped (not rich): one NDJSON line per sample, then the envelope; stderr stays empty", async () => {
		const { c, deps, io, writes } = setup({ rich: false });
		expect(await perfMetrics(c, deps, { app: APP, record: true, watch: true, duration: "2s" }, io)).toBe(0);
		const docs = c.stdout.map((l) => JSON.parse(l));
		expect(docs.filter((d) => d.type === "sample").map((d) => d.atMs)).toEqual([0, 1000, 2000]);
		expect(docs[docs.length - 1]).toMatchObject({ ok: true, command: "perf metrics" });
		expect(writes).toEqual([]);
	});

	test("--json on a TTY also streams NDJSON", async () => {
		const { c, deps, io, writes } = setup({ rich: true });
		await perfMetrics(c, deps, { app: APP, record: true, json: true, watch: true, duration: "1s" }, io);
		expect(c.stdout.filter((l) => JSON.parse(l).type === "sample")).toHaveLength(2);
		expect(writes).toEqual([]);
	});

	test("rich: sparklines redraw on stderr, stdout only gets the final summary", async () => {
		const { c, deps, io, writes } = setup({ rich: true });
		expect(await perfMetrics(c, deps, { app: APP, record: true, watch: true, duration: "2s" }, io)).toBe(0);
		expect(writes).toHaveLength(3);
		expect(writes[0]).toContain("cpu");
		expect(writes[0]).toMatch(/[▁-█]/);
		expect(writes[1]?.startsWith("\x1b[")).toBe(true);
		expect(writes[2]).toContain("cur 25.0%");
		expect(c.stdout.join("\n")).toContain("3 samples over 2.0s");
	});

	test("the fps row is drawn only when a source is supplied", async () => {
		const without = setup({ rich: true });
		await perfMetrics(without.c, without.deps, { app: APP, record: true, watch: true, duration: "1s" }, without.io);
		expect(without.writes.join("")).not.toContain("fps");
		ctx?.cleanup();

		const withFps = setup({ rich: true });
		withFps.io.fps = async () => 59.5;
		await perfMetrics(withFps.c, withFps.deps, { app: APP, record: true, watch: true, duration: "1s" }, withFps.io);
		expect(withFps.writes.join("")).toContain("cur 59.5 fps");
	});

	test("Ctrl-C ends the run with the summary and exit 130", async () => {
		const { c, deps, io, controller } = setup({ rich: false });
		let sleeps = 0;
		const sleep = io.sleep;
		io.sleep = async (ms, signal) => {
			await sleep(ms, signal);
			if (++sleeps === 2) controller.abort();
		};
		expect(await perfMetrics(c, deps, { app: APP, record: true, watch: true }, io)).toBe(130);
		const last = JSON.parse(c.stdout[c.stdout.length - 1] ?? "null");
		expect(last).toMatchObject({ ok: true, result: { interrupted: true } });
		expect(last.result.summary.count).toBe(2);
	});

	test("without --duration a watch is capped at 5 minutes", async () => {
		const { c, deps, io } = setup({ rich: false });
		await perfMetrics(c, deps, { app: APP, record: true, watch: true, interval: "30s" }, io);
		const last = JSON.parse(c.stdout[c.stdout.length - 1] ?? "null");
		expect(last.result.summary.durationMs).toBe(300_000);
	});
});
