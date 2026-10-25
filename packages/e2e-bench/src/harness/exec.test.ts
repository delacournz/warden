import { describe, expect, test } from "bun:test";
import { fakeExec, realExec, runOk } from "./exec";

describe("realExec", () => {
	test("runs a command and collects output with line callbacks", async () => {
		const lines: string[] = [];
		const r = await realExec.run("sh", ["-c", "echo one; echo two 1>&2; exit 3"], {
			onLine: (stream, line) => lines.push(`${stream}:${line}`),
		});
		expect(r.code).toBe(3);
		expect(r.stdout).toBe("one\n");
		expect(r.stderr).toBe("two\n");
		expect(lines).toEqual(["stdout:one", "stderr:two"]);
		expect(r.timedOut).toBe(false);
	});

	test("reports the child's CPU time at exit, the descendants it reaped included (bench-fidelity-R4)", async () => {
		const loop = "i=0; while [ $i -lt 60000 ]; do i=$((i+1)); done";
		const r = await realExec.run("sh", ["-c", `${loop}; (${loop})`]);
		expect(r.code).toBe(0);
		expect(r.cpuSec).toBeGreaterThan(0.01);
		expect(r.cpuSec).toBeLessThan(30);
	});

	test("times out", async () => {
		const r = await realExec.run("sh", ["-c", "sleep 5"], { timeoutMs: 100 });
		expect(r.timedOut).toBe(true);
		expect(r.durationMs).toBeLessThan(2_000);
	});

	test("a timeout is a bound even when a grandchild holds the pipes", async () => {
		const r = await realExec.run("sh", ["-c", "echo started; sleep 30 & wait"], { timeoutMs: 200 });
		expect(r.timedOut).toBe(true);
		expect(r.stdout).toBe("started\n");
		expect(r.durationMs).toBeLessThan(2_000);
	});

	test("the timeout kills the child's whole process group, not just the child", async () => {
		const r = await realExec.run("sh", ["-c", "sleep 30 & echo $!; wait"], { timeoutMs: 200 });
		const grandchild = Number(r.stdout.trim());
		expect(grandchild).toBeGreaterThan(0);
		await Bun.sleep(100);
		// gone, or a zombie waiting for a reaper (in a container pid 1 may never reap it)
		const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(grandchild)])
			.stdout.toString()
			.trim();
		expect(state === "" || state.startsWith("Z")).toBe(true);
	});

	test("reports a missing binary as a spawn error", async () => {
		const r = await realExec.run("/definitely/not/here", []);
		expect(r.spawnError).toBeDefined();
	});
});

describe("fakeExec", () => {
	test("answers from rules and records calls", async () => {
		const exec = fakeExec([{ cmd: "tool", match: (a) => a[0] === "--version", result: { stdout: "2.8.0\n" } }]);
		const r = await exec.run("tool", ["--version"]);
		expect(r.stdout).toBe("2.8.0\n");
		expect(exec.calls).toHaveLength(1);
		expect(exec.which("tool")).toBe("/fake/bin/tool");
		expect(exec.which("nope")).toBeUndefined();
		const miss = await exec.run("nope", []);
		expect(miss.code).toBe(127);
	});

	test("runOk turns a non-zero exit into an error", async () => {
		const exec = fakeExec([{ cmd: "x", result: { code: 2, stderr: "boom" } }]);
		const r = await runOk(exec, "x", ["a"]);
		expect(r).toEqual({ success: false, error: "x a exited 2: boom" });
	});
});
