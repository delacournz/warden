import { describe, expect, test } from "bun:test";
import { HELP, parseArgs } from "./args";

describe("parseArgs run", () => {
	test("defaults", () => {
		expect(parseArgs(["run"])).toEqual({
			command: "run",
			platform: "ios",
			frameworks: ["warden", "argent", "agent-device", "tester-army"],
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
			"argent,warden",
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
			"--app",
			".bench/app/android",
		]);
		expect(r).toEqual({
			command: "run",
			platform: "android",
			frameworks: ["warden", "argent"],
			runs: 5,
			retries: 1,
			udid: "emulator-5554",
			rebootBetween: true,
			out: "/tmp/o",
			skipDoctor: true,
			force: true,
			keepDrivers: true,
			nodeBin: "/n/bin/node",
			app: ".bench/app/android",
		});
	});

	test.each([
		[["run", "--platform", "web"], "--platform must be ios or android, got web"],
		[["run", "--runs", "0"], "--runs must be an integer >= 1, got 0"],
		[["run", "--retries", "-1"], "--retries must be an integer >= 0, got -1"],
		[
			["run", "--frameworks", "warden,nope"],
			"--frameworks: unknown nope; known: warden,argent,agent-device,tester-army",
		],
		[["run", "--udid"], "--udid needs a value"],
		[["run", "--udid", "--force"], "--udid needs a value"],
		[["run", "--bogus"], "unknown argument --bogus"],
		[["run", "extra"], "run takes no positional arguments, got extra"],
	])("complaint for %j", (argv, complaint) => {
		expect(parseArgs(argv)).toBe(complaint);
	});
});

describe("parseArgs app", () => {
	test("build, status, clean", () => {
		expect(parseArgs(["app", "build"])).toEqual({ command: "app-build", platform: "ios", force: false, eas: false });
		expect(parseArgs(["app", "build", "--platform", "android", "--force", "--eas"])).toEqual({
			command: "app-build",
			platform: "android",
			force: true,
			eas: true,
		});
		expect(parseArgs(["app", "status", "--platform", "android"])).toEqual({
			command: "app-status",
			platform: "android",
		});
		expect(parseArgs(["app", "clean"])).toEqual({ command: "app-clean", platform: "ios" });
	});

	test.each([
		[["app"], "app needs a subcommand: build|status|clean"],
		[["app", "nope"], "app needs a subcommand: build|status|clean"],
		[["app", "status", "--force"], "unknown argument --force"],
		[["app", "build", "--runs", "2"], "unknown argument --runs"],
		[["app", "clean", "x"], "app clean takes no positional arguments, got x"],
		[["run", "--eas"], "unknown argument --eas"],
	])("complaint for %j", (argv, complaint) => {
		expect(parseArgs(argv)).toBe(complaint);
	});

	test("help documents app", () => {
		expect(HELP).toContain("bench app build");
		expect(HELP).toContain("--app PATH");
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
		expect(parseArgs(["summary", "d"])).toEqual({ command: "summary", runDir: "d" });
		expect(parseArgs(["summary", "d", "--out", "f.json"])).toEqual({ command: "summary", runDir: "d", out: "f.json" });
		expect(parseArgs(["summary"])).toBe("summary needs <runDir>");
		expect(parseArgs(["summary", "d", "--platform", "ios"])).toBe("unknown argument --platform");
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
