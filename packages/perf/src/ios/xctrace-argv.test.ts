import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseToc, pickSchema } from "./export";
import { checkInstruments, checkXctraceInstruments, resetInstrumentCache } from "./instruments";
import { exportTableArgv, exportTocArgv, parseInstruments, recordArgv, tableXpath } from "./xctrace-argv";

describe("recordArgv", () => {
	test("attach", () => {
		expect(
			recordArgv({
				output: "/o/ios.trace",
				instruments: ["Hangs"],
				target: { kind: "attach", udid: "U", pid: 42 },
				timeLimitMs: 30_000,
			})
		).toEqual([
			"xcrun",
			"xctrace",
			"record",
			"--template",
			"Time Profiler",
			"--instrument",
			"Hangs",
			"--output",
			"/o/ios.trace",
			"--no-prompt",
			"--time-limit",
			"30s",
			"--device",
			"U",
			"--attach",
			"42",
		]);
	});
	test("all-processes has no --device", () => {
		const argv = recordArgv({ output: "o", instruments: [], target: { kind: "all-processes" } });
		expect(argv).toContain("--all-processes");
		expect(argv).not.toContain("--device");
	});
	test("launch puts env before --launch and the app after --", () => {
		const argv = recordArgv({
			output: "o",
			instruments: ["Hangs", "Leaks", "Allocations"],
			target: { kind: "launch", udid: "U", appPath: "/x/App.app", env: { MallocStackLogging: "1" } },
		});
		expect(argv.slice(-5)).toEqual(["--env", "MallocStackLogging=1", "--launch", "--", "/x/App.app"]);
		expect(argv.join(" ")).toContain("--instrument Leaks --instrument Allocations");
	});
});

describe("export argv", () => {
	test("toc and xpath", () => {
		expect(exportTocArgv("t.trace")).toEqual(["xcrun", "xctrace", "export", "--input", "t.trace", "--toc"]);
		expect(tableXpath("time-profile")).toBe('/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]');
		expect(exportTableArgv("t", "leaks", "/o.xml")).toContain("--output");
	});
});

describe("toc", () => {
	const toc = readFileSync(new URL("../../fixtures/xctrace-toc.xml", import.meta.url), "utf8");
	test("parses runs, schemas, duration, target", () => {
		const [run] = parseToc(toc);
		expect(run?.number).toBe(1);
		expect(run?.durationMs).toBe(10_250);
		expect(run?.process).toEqual({ name: "ShopApp", pid: 4242 });
		expect(run?.schemas).toEqual(["time-profile", "potential-hangs", "leaks", "tick"]);
		expect(run && pickSchema(run, ["hang-risks", "potential-hangs"])).toBe("potential-hangs");
		expect(run && pickSchema(run, ["nope"], "leak")).toBe("leaks");
	});
});

describe("instruments", () => {
	const listing = "== Standard Instruments ==\nHangs\nHitches\nLeaks\nTime Profiler\n";
	beforeEach(resetInstrumentCache);
	test("parse drops headers", () => {
		expect(parseInstruments(listing)).toEqual(["Hangs", "Hitches", "Leaks", "Time Profiler"]);
	});
	test("missing instrument lists alternatives", () => {
		const check = checkInstruments(["Hangs", "Allocations"], ["Hitches", "Leaks"]);
		expect(check.ok).toBe(false);
		if (!check.ok) {
			expect(check.missing).toEqual(["Hangs", "Allocations"]);
			expect(check.alternatives.Hangs).toContain("Hitches");
			expect(check.alternatives.Allocations).toContain("Leaks");
		}
	});
	test("listing is fetched once", async () => {
		let calls = 0;
		const run = async () => {
			calls++;
			return { exitCode: 0, stdout: listing, stderr: "" };
		};
		await checkXctraceInstruments(run, ["Hangs"]);
		const second = await checkXctraceInstruments(run, ["Leaks"]);
		expect(calls).toBe(1);
		expect(second?.ok).toBe(true);
	});
	test("a failing xctrace is undefined", async () => {
		expect(
			await checkXctraceInstruments(async () => ({ exitCode: 1, stdout: "", stderr: "x" }), ["Hangs"])
		).toBeUndefined();
	});
});
