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

	test("times out", async () => {
		const r = await realExec.run("sh", ["-c", "sleep 5"], { timeoutMs: 100 });
		expect(r.timedOut).toBe(true);
	});

	test("reports a missing binary as a spawn error", async () => {
		const r = await realExec.run("/definitely/not/here", []);
		expect(r.spawnError).toBeDefined();
	});
});

describe("fakeExec", () => {
	test("answers from rules and records calls", async () => {
		const exec = fakeExec([{ cmd: "maestro", match: (a) => a[0] === "--version", result: { stdout: "2.8.0\n" } }]);
		const r = await exec.run("maestro", ["--version"]);
		expect(r.stdout).toBe("2.8.0\n");
		expect(exec.calls).toHaveLength(1);
		expect(exec.which("maestro")).toBe("/fake/bin/maestro");
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
