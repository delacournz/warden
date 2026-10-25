import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2eError } from "../errors";
import { createDevicePerf, type PerfExec, perfStartFor } from "./device-perf";

const ok = (result: unknown) => ({
	code: 0,
	stdout: JSON.stringify({ ok: true, command: "perf", result }),
	stderr: "",
});

function setup(metrics: Record<string, unknown>, budgets = {}) {
	const root = mkdtempSync(join(tmpdir(), "perf-"));
	const sessionDir = join(root, "session");
	require("node:fs").mkdirSync(sessionDir);
	const reportPath = join(sessionDir, "report.json");
	const report = {
		version: 1,
		sessionId: "s1",
		durationMs: 1000,
		banners: [],
		summary: [],
		findings: [],
		marks: [],
		next: [],
		metrics: { topFunctions: [], ...metrics },
	};
	writeFileSync(reportPath, JSON.stringify(report));
	writeFileSync(join(sessionDir, "report.md"), "# report");
	const calls: string[][] = [];
	const exec: PerfExec = async (argv) => {
		calls.push([...argv]);
		if (argv[1] === "start") return ok({ sessionId: "s1" });
		if (argv[1] === "stop") return ok({ sessionId: "s1", dir: sessionDir, reportPath, report });
		return ok({});
	};
	const files = new Set<string>();
	const attempt = join(root, "attempt");
	const perf = createDevicePerf({ exec, udid: "U1", budgets, attemptDir: () => attempt, addFile: (f) => files.add(f) });
	return { perf, calls, files, attempt };
}

describe("device.perf", () => {
	test("start passes flags and the udid", async () => {
		const { perf, calls } = setup({});
		expect(await perf.start({ react: true, native: "perfetto", maxDurationMs: 45_000, relaunch: true })).toEqual({
			sessionId: "s1",
		});
		expect(calls[0]).toEqual([
			"perf",
			"start",
			"--json",
			"--udid",
			"U1",
			"--react",
			"--native=perfetto",
			"--relaunch",
			"--max-duration",
			"45s",
		]);
		expect(perf.active).toBe(true);
	});

	test("mark sends the label", async () => {
		const { perf, calls } = setup({});
		await perf.mark("scroll");
		expect(calls[0]?.slice(-1)).toEqual(["scroll"]);
	});

	test("stop copies the report under perf/ and records the files", async () => {
		const { perf, files, attempt } = setup({ jankPct: 1 });
		await perf.start();
		const report = await perf.stop();
		expect(report.reportPath).toBe(join(attempt, "perf", "report.json"));
		expect(existsSync(join(attempt, "perf", "report.md"))).toBe(true);
		expect(JSON.parse(readFileSync(join(attempt, "perf", "session.json"), "utf8")).sessionId).toBe("s1");
		expect([...files].sort()).toEqual(["perf/report.json", "perf/report.md", "perf/session.json"]);
		expect(perf.active).toBe(false);
	});

	test("a breach throws PERF_BUDGET naming metric, value, budget and report", async () => {
		const { perf, attempt } = setup({ jankPct: 12 }, { jankPct: 5 });
		await perf.start();
		const error = await perf.stop().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(E2eError);
		expect((error as E2eError).code).toBe("PERF_BUDGET");
		expect((error as E2eError).message).toContain("jankPct: 12 > budget 5");
		expect((error as E2eError).message).toContain(join(attempt, "perf", "report.json"));
	});

	test("per-spec budgets override the suite's", async () => {
		const { perf } = setup({ jankPct: 12 }, { jankPct: 5 });
		await perf.start();
		expect((await perf.stop({ budgets: { jankPct: 20 } })).metrics.jankPct).toBe(12);
	});

	test("a failed warden call is a SESSION error with the cause", async () => {
		const exec: PerfExec = async () => ({
			code: 1,
			stdout: JSON.stringify({ ok: false, error: { code: "session_active", message: "busy" } }),
			stderr: "",
		});
		const perf = createDevicePerf({ exec, udid: "U", budgets: {}, attemptDir: () => undefined });
		await expect(perf.start()).rejects.toThrow("session_active: busy");
	});

	test("without WARDEN_BIN it says so", async () => {
		const perf = createDevicePerf({
			exec: async () => ok({}),
			udid: "U",
			budgets: {},
			attemptDir: () => undefined,
			unavailable: "no bin",
		});
		await expect(perf.mark("x")).rejects.toThrow("device.perf unavailable: no bin");
	});
});

describe("perfStartFor", () => {
	test("all, a list, nothing known", () => {
		expect(perfStartFor(["all"])).toEqual({ all: true });
		expect(perfStartFor(["react", "js", "x"])).toEqual({ js: true, react: true });
		expect(perfStartFor([])).toEqual({});
	});
});
