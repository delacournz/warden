import { describe, expect, test } from "bun:test";
import { harnessArgs, type Iteration, iterationFlagged, markdownTable, pickDeviceType, pickRuntime } from "./hunt";
import { summarize } from "./witness";

describe("pickRuntime", () => {
	test("takes the newest available iOS runtime, numerically", () => {
		const runtime = (version: string, isAvailable = true, platform = "iOS") => ({
			identifier: `com.apple.CoreSimulator.SimRuntime.${platform}-${version.replace(".", "-")}`,
			name: `${platform} ${version}`,
			version,
			isAvailable,
			platform,
		});
		const picked = pickRuntime([
			runtime("26.9"),
			runtime("27.2"),
			runtime("27.10"),
			runtime("28.0", false),
			runtime("12.0", true, "watchOS"),
		]);
		expect(picked?.version).toBe("27.10");
	});

	test("none installed", () => {
		expect(pickRuntime([])).toBeUndefined();
	});
});

describe("pickDeviceType", () => {
	test("the newest plain iPhone, skipping Pro / Air / SE / Max variants", () => {
		const type = (name: string) => ({
			name,
			identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replace(/ /g, "-")}`,
		});
		const picked = pickDeviceType([
			type("iPhone 16"),
			type("iPhone 17"),
			type("iPhone 17 Pro"),
			type("iPhone Air"),
			type("iPad Pro 13-inch"),
		]);
		expect(picked?.name).toBe("iPhone 17");
	});
});

describe("markdownTable", () => {
	test("flags an iteration with a silent streak and shows the runner's answers", () => {
		const records = [1, 2, 3].flatMap((n) => [
			{
				kind: "read" as const,
				round: n,
				source: "simd" as const,
				tMs: n * 1000,
				latencyMs: 100,
				outcome: "silent" as const,
			},
			{
				kind: "read" as const,
				round: n,
				source: "runner" as const,
				tMs: n * 1000 + 100,
				latencyMs: 50,
				outcome: "answered" as const,
			},
		]);
		const summary = summarize(records);
		const rows: Iteration[] = [
			{ index: 1, status: "ok", udid: "u", verdict: summary.verdict, flagged: true, summary },
			{ index: 2, status: "infra-failure", reason: "no runtime" },
		];
		const table = markdownTable(rows);
		expect(table).toContain("witness-answers (FLAGGED)");
		expect(table).toContain("runner answered");
		expect(table).toContain("infra failure");
	});

	test("an iteration whose runner never started is flagged with the reason and simd's silence", () => {
		const summary = summarize([
			...[1, 2, 3].map((n) => ({
				kind: "read" as const,
				round: n,
				source: "simd" as const,
				tMs: n * 1000,
				latencyMs: 15_000,
				outcome: "silent" as const,
			})),
			{ kind: "note", tMs: 450_000, text: "runner failure: runner not ready after 420 s" },
		]);
		const table = markdownTable([
			{ index: 1, status: "ok", udid: "u", verdict: summary.verdict, flagged: iterationFlagged(summary), summary },
		]);
		expect(table).toContain("witness-unread (FLAGGED)");
		expect(table).toContain("3/3");
		expect(table).toContain("runner never ready: runner not ready after 420 s");
	});
});

describe("iterationFlagged", () => {
	test("a silent streak or a runner that never started flags the iteration", () => {
		const quiet = summarize([]);
		expect(iterationFlagged(quiet)).toBe(false);
		expect(iterationFlagged(summarize([{ kind: "note", tMs: 1, text: "runner failure: xcodebuild exited 65" }]))).toBe(
			true
		);
	});
});

describe("harnessArgs", () => {
	const base = { script: "ax-witness.ts", udid: "u", seconds: 120, minStreak: 3, dir: "out/iteration-2" };

	test("builds the runner until an earlier iteration got past the build", () => {
		expect(harnessArgs({ ...base, built: false })).not.toContain("--skip-build");
	});

	test("skips the build once an earlier iteration came back ok", () => {
		expect(harnessArgs({ ...base, built: true })).toContain("--skip-build");
	});

	test("observes the given sim for the given time", () => {
		expect(harnessArgs({ ...base, built: false })).toEqual([
			"ax-witness.ts",
			"--udid",
			"u",
			"--observe",
			"--seconds",
			"120",
			"--min-streak",
			"3",
			"--out",
			"out/iteration-2",
		]);
	});
});
