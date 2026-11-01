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

	test("onLine streams each output line as it arrives, stdout and stderr, and still returns the whole output", async () => {
		const lines: string[] = [];
		const res = await bunExec(["sh", "-c", "printf 'a\\nb'; echo c >&2; sleep 0.05; printf 'd\\n'"], {
			onLine: (line) => lines.push(line),
		});
		expect(res.stdout).toBe("a\nbd\n");
		expect(lines.sort()).toEqual(["a", "bd", "c"]);
	});

	test("onLine flushes a last line without a newline", async () => {
		const lines: string[] = [];
		await bunExec(["sh", "-c", "printf 'tail'"], { onLine: (line) => lines.push(line) });
		expect(lines).toEqual(["tail"]);
	});

	test("an aborted signal kills the command", async () => {
		const abort = new AbortController();
		const started = Date.now();
		const pending = bunExec(["sleep", "30"], { signal: abort.signal });
		setTimeout(() => abort.abort(), 50);
		const res = await pending;
		expect(res.exitCode).not.toBe(0);
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});

describe("execError", () => {
	test("one line with the command, exit code and the tail of the output", () => {
		expect(execError(["a", "b"], { exitCode: 2, stdout: "", stderr: "x\ny\n" })).toBe("`a b` exited 2: x | y");
	});
});
