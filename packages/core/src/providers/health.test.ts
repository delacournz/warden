import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../exec";
import { probeIosHealth, springboardRunning } from "./health";

const LIST = "PID\tStatus\tLabel\n412\t0\tUIKitApplication:com.apple.springboard[abcd][rb-legacy]\n-\t0\tcom.apple.foo";
const never = () => new Promise<ExecResult>(() => {});
const instant = () => ({ promise: Promise.resolve(), cancel: () => {} });
const forever = () => ({ promise: new Promise<void>(() => {}), cancel: () => {} });

function exec(handlers: Record<string, () => Promise<ExecResult>>): Exec {
	return (cmd) => {
		const hit = Object.entries(handlers).find(([k]) => cmd.join(" ").includes(k));
		return hit ? hit[1]() : Promise.resolve({ exitCode: 127, stdout: "", stderr: "" });
	};
}
const done =
	(stdout = "", exitCode = 0) =>
	() =>
		Promise.resolve({ exitCode, stdout, stderr: "" });

describe("springboardRunning", () => {
	test("needs a numeric pid", () => {
		expect(springboardRunning(LIST)).toBe(true);
		expect(springboardRunning("-\t0\tUIKitApplication:com.apple.springboard[x]")).toBe(false);
		expect(springboardRunning("")).toBe(false);
	});
});

describe("probeIosHealth", () => {
	test("healthy", async () => {
		const res = await probeIosHealth(
			{ exec: exec({ "print system": done(), "launchctl list": done(LIST) }), timer: forever },
			"U1"
		);
		expect(res.success).toBe(true);
	});

	test("hung launchctl times out without real waiting", async () => {
		const res = await probeIosHealth({ exec: exec({ "print system": never }), timer: instant }, "U1");
		expect(res).toEqual({ success: false, error: "U1: launchctl print system did not answer within 15s" });
	});

	test("one timeout is retried with a longer budget: a slow answer on a busy host is healthy", async () => {
		const timeouts: number[] = [];
		let calls = 0;
		const slowOnce: Exec = (cmd, options) => {
			if (!cmd.join(" ").includes("print system")) return done(LIST)();
			timeouts.push(options?.timeoutMs ?? 0);
			calls += 1;
			return calls === 1 ? Promise.resolve({ exitCode: 124, stdout: "", stderr: "" }) : done()();
		};
		const res = await probeIosHealth({ exec: slowOnce, timer: forever }, "U1");
		expect(res.success).toBe(true);
		expect(timeouts).toEqual([5_000, 15_000]);
	});

	test("non-zero launchctl fails", async () => {
		const res = await probeIosHealth({ exec: exec({ "print system": done("", 1) }), timer: forever }, "U1");
		expect(res.success).toBe(false);
	});

	test("SpringBoard down fails", async () => {
		const res = await probeIosHealth(
			{ exec: exec({ "print system": done(), "launchctl list": done("PID\tStatus\tLabel") }), timer: forever },
			"U1"
		);
		expect(res).toEqual({ success: false, error: "U1: SpringBoard is not running" });
	});
});
