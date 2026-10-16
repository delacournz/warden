import { describe, expect, test } from "bun:test";
import { HELP, parseArgs } from "./args";

describe("parseArgs run", () => {
	test("defaults", () => {
		expect(parseArgs(["run"])).toEqual({
			command: "run",
			platform: "ios",
			frameworks: ["warden", "maestro", "argent", "agent-device", "tester-army", "detox"],
			runs: 3,
			retries: 0,
			rebootBetween: false,
			skipDoctor: false,
			force: false,
			keepDrivers: false,
		});
	});

	test("every flag", () => {
		const r = parseArgs([
			"run",
			"--platform",
			"android",
			"--frameworks",
			"detox,warden",
			"--runs",
			"5",
			"--retries",
			"1",
			"--udid",
			"emulator-5554",
			"--reboot-between",
			"--out",
			"/tmp/o",
			"--skip-doctor",
			"--force",
			"--keep-drivers",
			"--node-bin",
			"/n/bin/node",
		]);
		expect(r).toEqual({
			command: "run",
			platform: "android",
			frameworks: ["warden", "detox"],
			runs: 5,
			retries: 1,
			udid: "emulator-5554",
			rebootBetween: true,
			out: "/tmp/o",
			skipDoctor: true,
			force: true,
			keepDrivers: true,
			nodeBin: "/n/bin/node",
		});
	});

	test.each([
		[["run", "--platform", "web"], "--platform must be ios or android, got web"],
		[["run", "--runs", "0"], "--runs must be an integer >= 1, got 0"],
		[["run", "--retries", "-1"], "--retries must be an integer >= 0, got -1"],
		[
			["run", "--frameworks", "warden,nope"],
			"--frameworks: unknown nope; known: warden,maestro,argent,agent-device,tester-army,detox",
		],
		[["run", "--udid"], "--udid needs a value"],
		[["run", "--udid", "--force"], "--udid needs a value"],
		[["run", "--bogus"], "unknown argument --bogus"],
		[["run", "extra"], "run takes no positional arguments, got extra"],
	])("complaint for %j", (argv, complaint) => {
		expect(parseArgs(argv)).toBe(complaint);
	});
});

describe("other commands", () => {
	test("doctor takes only --platform", () => {
		expect(parseArgs(["doctor", "--platform", "android"])).toEqual({ command: "doctor", platform: "android" });
		expect(parseArgs(["doctor", "--runs", "2"])).toBe("unknown argument --runs");
	});

	test("list, report, compare", () => {
		expect(parseArgs(["list", "x"])).toBe("list takes no positional arguments, got x");
		expect(parseArgs(["list"])).toEqual({ command: "list" });
		expect(parseArgs(["report", "d"])).toEqual({ command: "report", runDir: "d" });
		expect(parseArgs(["report"])).toBe("report needs <runDir>");
		expect(parseArgs(["compare", "a", "b"])).toEqual({ command: "compare", dirA: "a", dirB: "b" });
		expect(parseArgs(["compare", "a"])).toBe("compare needs <dirA> <dirB>");
	});

	test("help and unknown", () => {
		expect(parseArgs([])).toEqual({ command: "help" });
		expect(parseArgs(["--help"])).toEqual({ command: "help" });
		expect(parseArgs(["nope"])).toBe("unknown command nope");
		expect(HELP).toContain("bench run");
	});
});
