import { describe, expect, test } from "bun:test";
import { bunExec, execError } from "./exec";

describe("bunExec", () => {
	test("returns the exit code and output of the command", async () => {
		const res = await bunExec(["sh", "-c", "echo out; echo err >&2; exit 3"]);
		expect(res).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
	});

	test("a missing binary is exit 127 with a message, never a throw", async () => {
		const res = await bunExec(["warden-no-such-binary-xyz", "--version"]);
		expect(res.exitCode).toBe(127);
		expect(res.stderr).toContain("warden-no-such-binary-xyz");
	});

	test("a missing cwd is exit 127 naming the directory", async () => {
		const res = await bunExec(["git", "status"], { cwd: "/no/such/warden/dir" });
		expect(res.exitCode).toBe(127);
		expect(res.stderr).toContain("/no/such/warden/dir");
	});
});

describe("execError", () => {
	test("one line with the command, exit code and the tail of the output", () => {
		expect(execError(["a", "b"], { exitCode: 2, stdout: "", stderr: "x\ny\n" })).toBe("`a b` exited 2: x | y");
	});
});
