import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "@delacour/warden-runtime/exec";
import { wardenErrors } from "@delacour/warden-types/error";
import { BoundedExec, IosHealth, launchctlRows } from "./health";

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
		expect(launchctlRows.springboardRunning(LIST)).toBe(true);
		expect(launchctlRows.springboardRunning("-\t0\tUIKitApplication:com.apple.springboard[x]")).toBe(false);
		expect(launchctlRows.springboardRunning("")).toBe(false);
	});
});

describe("probeIosHealth", () => {
	test("healthy", async () => {
		const res = await new IosHealth({
			exec: exec({ "print system": done(), "launchctl list": done(LIST) }),
			timer: forever,
		}).probe("U1");
		expect(res.success).toBe(true);
	});

	test("hung launchctl times out without real waiting", async () => {
		const res = await new IosHealth({ exec: exec({ "print system": never }), timer: instant }).probe("U1");
		expect(res).toEqual(
			wardenErrors.err("probe_timeout", "U1: launchctl print system did not answer within 15s", { retryable: true })
		);
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
		const res = await new IosHealth({ exec: slowOnce, timer: forever }).probe("U1");
		expect(res.success).toBe(true);
		expect(timeouts).toEqual([5_000, 15_000]);
	});

	test("non-zero launchctl fails", async () => {
		const res = await new IosHealth({ exec: exec({ "print system": done("", 1) }), timer: forever }).probe("U1");
		expect(res.success).toBe(false);
	});

	test("SpringBoard down fails", async () => {
		const res = await new IosHealth({
			exec: exec({ "print system": done(), "launchctl list": done("PID\tStatus\tLabel") }),
			timer: forever,
		}).probe("U1");
		expect(res).toEqual(wardenErrors.err("failed", "U1: SpringBoard is not running"));
	});
});

describe("probeIosHealth ordering", () => {
	test("print system and launchctl list are asked at the same time, not one after the other", async () => {
		const started: string[] = [];
		const finished: string[] = [];
		const slow: Exec = async (cmd) => {
			const name = cmd.includes("print") ? "print" : "list";
			started.push(name);
			await Bun.sleep(10);
			finished.push(name);
			return { exitCode: 0, stdout: name === "list" ? LIST : "", stderr: "" };
		};
		const res = await new IosHealth({ exec: slow, timer: forever }).probe("U1");
		expect(res.success).toBe(true);
		expect(started).toEqual(["print", "list"]);
		expect(finished).toHaveLength(2);
	});

	test("print system is still reported first when both fail", async () => {
		const res = await new IosHealth({
			exec: exec({ "print system": done("", 1), "launchctl list": done("", 1) }),
			timer: forever,
		}).probe("U1");
		expect(res).toEqual(wardenErrors.err("failed", "U1: launchctl print system exited 1"));
	});
});

describe("probeIosWarm", () => {
	test("one spawn: launchctl list answering with SpringBoard running", async () => {
		const calls: string[] = [];
		const counting: Exec = async (cmd) => {
			calls.push(cmd.join(" "));
			return { exitCode: 0, stdout: LIST, stderr: "" };
		};
		expect((await new IosHealth({ exec: counting, timer: forever }).probeWarm("U1")).success).toBe(true);
		expect(calls).toEqual(["xcrun simctl spawn U1 launchctl list"]);
	});

	test("SpringBoard down, launchctl failing and a hung launchd all fail", async () => {
		const down = await new IosHealth({
			exec: exec({ "launchctl list": done("PID\tStatus\tLabel") }),
			timer: forever,
		}).probeWarm("U1");
		expect(down).toEqual(wardenErrors.err("failed", "U1: SpringBoard is not running"));
		const failing = await new IosHealth({ exec: exec({ "launchctl list": done("", 1) }), timer: forever }).probeWarm(
			"U1"
		);
		expect(failing.success).toBe(false);
		const hung = await new IosHealth({ exec: exec({ "launchctl list": never }), timer: instant }).probeWarm("U1");
		expect(hung).toEqual(
			wardenErrors.err("probe_timeout", "U1: launchctl list did not answer within 15s", { retryable: true })
		);
	});
});

describe("execWithin / probe_timeout (16-10, 16-11)", () => {
	test("an exec that never returns gives undefined once the timer fires; the exec is told the timeout too", async () => {
		const seen: Array<number | undefined> = [];
		const hung: Exec = (_cmd, opts) => {
			seen.push(opts?.timeoutMs);
			return never();
		};
		expect(
			await new BoundedExec({ exec: hung, timer: instant }).within(["xcrun", "simctl", "boot", "U1"], 120_000)
		).toBeUndefined();
		expect(seen).toEqual([120_000]);
	});

	test("a process killed by Bun's timeout (SIGTERM, 143) or timeout(1) (124) is no answer, not a failure", async () => {
		for (const exitCode of [124, 143]) {
			const killed = exec({ "launchctl list": done("", exitCode) });
			expect(await new BoundedExec({ exec: killed, timer: forever }).within(["launchctl", "list"], 10)).toBeUndefined();
		}
		const failed = exec({ "launchctl list": done("", 1) });
		expect((await new BoundedExec({ exec: failed, timer: forever }).within(["launchctl", "list"], 10))?.exitCode).toBe(
			1
		);
	});

	test("a hung probe is a timeout; SpringBoard down is not", async () => {
		const hung = await new IosHealth({ exec: exec({ "print system": never }), timer: instant }).probe("U1");
		expect(!hung.success && hung.error.code).toBe("probe_timeout");
		const down = await new IosHealth({
			exec: exec({ "launchctl list": done("PID\tStatus\tLabel") }),
			timer: forever,
		}).probeWarm("U1");
		expect(!down.success && down.error.code).toBe("failed");
	});
});
