import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSamples } from "@delacour/warden-perf/metrics/series";
import { type TestContext, testContext } from "../testing";
import { COLLECT_METRICS_INTERVAL_MS, createMetricsTicker } from "./collect-metrics";

let ctx: TestContext | undefined;
let dir: string | undefined;
afterEach(() => {
	ctx?.cleanup();
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

const topOut = " 4321 u0_a123      10 -10  14G 250M 120M S  25.0   6.5   0:30.11 nz.co.x\n";

function setup(opts: { running: () => boolean }) {
	const clock = { now: 50_000 };
	dir = mkdtempSync(join(tmpdir(), "warden-collect-"));
	const c = testContext([], {
		now: () => clock.now,
		exec: async (cmd) => {
			const joined = cmd.join(" ");
			if (!opts.running()) return { exitCode: 0, stdout: "", stderr: "" };
			if (joined.includes("pidof")) return { exitCode: 0, stdout: "4321\n", stderr: "" };
			if (joined.includes("shell top")) return { exitCode: 0, stdout: topOut, stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "" };
		},
	});
	ctx = c;
	return { c, clock };
}

const target = { udid: "emulator-5554", platform: "android", app: "nz.co.x" } as const;

describe("createMetricsTicker", () => {
	test("each tick appends a sample row timed from the session start", async () => {
		const { c, clock } = setup({ running: () => true });
		const made = await createMetricsTicker(c, { target, sessionDir: dir ?? "", startMs: 49_000 });
		if (!made.success) throw new Error("create");
		await made.data.tick();
		clock.now += COLLECT_METRICS_INTERVAL_MS;
		await made.data.tick();
		const rows = decodeSamples(readFileSync(join(dir ?? "", "metrics", "samples.jsonl"), "utf8"));
		expect(rows.map((r) => r.atMs)).toEqual([1000, 2000]);
		expect(rows[0]).toMatchObject({ pid: 4321, cpuPct: 25, rssKb: 256000 });
	});

	test("the app being down is a gap: undefined, nothing written, no throw", async () => {
		let up = true;
		const { c } = setup({ running: () => up });
		const made = await createMetricsTicker(c, { target, sessionDir: dir ?? "", startMs: 0 });
		if (!made.success) throw new Error("create");
		await made.data.tick();
		up = false;
		expect(await made.data.tick()).toBeUndefined();
		const rows = decodeSamples(readFileSync(join(dir ?? "", "metrics", "samples.jsonl"), "utf8"));
		expect(rows).toHaveLength(1);
	});

	test("a supplied frame-rate source adds fps to the row", async () => {
		const { c } = setup({ running: () => true });
		const made = await createMetricsTicker(c, { target, sessionDir: dir ?? "", startMs: 0, fps: async () => 58.5 });
		if (!made.success) throw new Error("create");
		expect(await made.data.tick()).toMatchObject({ fps: 58.5 });
	});
});
