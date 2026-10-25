import { afterEach, describe, expect, test } from "bun:test";
import { simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import { defineCommand } from "../command";
import { fakeExec, type TestContext, testContext } from "../testing";
import { registerSimMeasure } from "./sim-measure";

let ctx: TestContext | undefined;
afterEach(() => {
	ctx?.cleanup();
	ctx = undefined;
});

const simCommand = defineCommand({ name: "sim", group: "Devices", summary: "x", register: registerSimMeasure });

const BOOTED = simctlDevicesJson({
	"iOS-26-5": [
		{ udid: "U1", name: "a", state: "Booted" },
		{ udid: "U2", name: "b", state: "Booted" },
	],
});
const PS = "  PID  PPID COMM\n 100 1 /x/launchd_sim\n 101 100 /x/backboardd\n 200 1 /x/launchd_sim\n";
const TOP = "PID MEM\n100 2M\n101 168M+\n200 10M\n";

function setup(argv: string[]): TestContext {
	ctx = testContext(argv, {
		exec: fakeExec([
			["xcrun simctl list devices booted", { stdout: BOOTED }],
			["pgrep -f U1/data", { stdout: "100\n" }],
			["pgrep -f U2/data", { stdout: "200\n" }],
			["pgrep", { exitCode: 1 }],
			["ps", { stdout: PS }],
			["top", { stdout: TOP }],
		]),
	});
	return ctx;
}

describe("warden sim measure", () => {
	test("<udid> prints procs and MB, then the top processes", async () => {
		const c = setup(["measure", "U1"]);
		expect(await simCommand.run(c)).toBe(0);
		const out = c.stdout.join("\n");
		expect(out).toContain("U1: 2 procs, 170 MB");
		expect(out).toContain("backboardd");
	});

	test("--booted --json lists every booted sim with footprintMb", async () => {
		const c = setup(["measure", "--booted", "--json"]);
		expect(await simCommand.run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.map((r: { udid: string; footprintMb: number }) => [r.udid, r.footprintMb])).toEqual([
			["U1", 170],
			["U2", 10],
		]);
	});

	test("a sim that is not booted fails with exit 1", async () => {
		const c = setup(["measure", "U9"]);
		expect(await simCommand.run(c)).toBe(1);
		expect(c.stdout.join("\n")).toContain("not booted");
	});

	test("neither udid nor --booted is a usage error", async () => {
		const c = setup(["measure"]);
		expect(await simCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("pass <udid> or --booted");
	});
});
