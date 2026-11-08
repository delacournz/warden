import { describe, expect, test } from "bun:test";
import { bunExec, type Exec } from "@delacour/warden-core/exec";
import { simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { testContext } from "../testing";
import { harness } from "./batch.testing";
import { createE2eCommand } from "./e2e";
import { ctx, dir, resuite, setCtx, useE2eFixture } from "./e2e.testing";

useE2eFixture();

const RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.";
const INSTALLED = ["iOS-26-1", "iOS-26-5", "iOS-27-0"];

const runtimesJson = (installed: string[]): string =>
	JSON.stringify({
		runtimes: installed.map((id) => ({
			identifier: `${RUNTIME_PREFIX}${id}`,
			name: `iOS ${id.slice(4).replace("-", ".")}`,
			version: id.slice(4).replace("-", "."),
			platform: "iOS",
			isAvailable: true,
		})),
	});

/** One booted warden sim per installed runtime: U1 on 26.1, U2 on 26.5, U3 on 27.0. */
function runtimeCtx(argv: string[], calls: string[][] = []) {
	const sims = {
		"iOS-26-1": [wardenSim(1, "Booted")],
		"iOS-26-5": [wardenSim(2, "Booted")],
		"iOS-27-0": [wardenSim(3, "Booted")],
	};
	const sim = fakeSimctl([], calls, [
		["xcrun simctl list devices available -j", { stdout: simctlDevicesJson(sims) }],
		["xcrun simctl list runtimes -j", { stdout: runtimesJson(INSTALLED) }],
	]);
	const exec: Exec = (cmd, opts) => (cmd[0] === "git" ? bunExec(cmd, opts) : sim(cmd, opts));
	setCtx(testContext(argv, { exec }));
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	ctx.cwd = dir;
	return ctx;
}

const udids = (h: ReturnType<typeof harness>) => new Set(h.jobs().map((j) => j.opts.env.WARDEN_UDID));

describe("warden e2e runtime pin", () => {
	test("the suite's runtime picks the device on that runtime", async () => {
		await resuite({ runtime: "27.0" });
		const c = runtimeCtx(["--all"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(udids(h)).toEqual(new Set(["U3"]));
	});

	test("--runtime overrides the suite's runtime", async () => {
		await resuite({ runtime: "27.0" });
		const c = runtimeCtx(["--all", "--runtime", "iOS-26-1"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(udids(h)).toEqual(new Set(["U1"]));
	});

	test("a runtime that is not installed fails before any claim, listing the installed ones", async () => {
		await resuite({ runtime: "27.5" });
		const calls: string[][] = [];
		const c = runtimeCtx(["--all"], calls);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(1);
		const err = c.stderr.join("\n");
		expect(err).toContain('iOS runtime "27.5" is not installed');
		expect(err).toContain("installed: iOS-27-0, iOS-26-5, iOS-26-1");
		expect(h.jobs()).toEqual([]);
		expect(c.db.listLeases()).toEqual([]);
		expect(calls.some((cmd) => cmd.includes("boot"))).toBe(false);
	});

	test("a suite without a runtime never lists runtimes", async () => {
		const calls: string[][] = [];
		const c = runtimeCtx(["--all"], calls);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(calls.some((cmd) => cmd.join(" ").includes("list runtimes"))).toBe(false);
	});
});
