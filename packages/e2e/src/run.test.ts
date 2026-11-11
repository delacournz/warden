import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2eError } from "./errors";
import { createRun, run } from "./run";
import { runSpan } from "./runner/span";
import type { TraceEvent } from "./runner/trace";

describe("run", () => {
	test("a string runs through sh -c and captures stdout and stderr", async () => {
		const result = await run("echo hello && echo oops >&2");
		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello\n");
		expect(result.stderr).toBe("oops\n");
		expect(result.ms).toBeGreaterThanOrEqual(0);
	});

	test("an argv array runs without a shell", async () => {
		const result = await run(["echo", "$HOME && no shell"]);
		expect(result.stdout).toBe("$HOME && no shell\n");
	});

	test("json() parses stdout", async () => {
		const result = await run(`echo '{"id":"abc","n":2}'`);
		expect(result.json()).toEqual({ id: "abc", n: 2 });
	});

	test("json() on stdout that is not JSON throws INVALID_ARGUMENT", async () => {
		const result = await run("echo not-json");
		expect(() => result.json()).toThrow(E2eError);
		try {
			result.json();
		} catch (error) {
			expect(error instanceof E2eError && error.code).toBe("INVALID_ARGUMENT");
		}
	});

	test("a non-zero exit throws RUN_FAILED naming the exit code and stderr", async () => {
		const failure = await run("echo boom >&2; exit 3").catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(E2eError);
		const error = failure as E2eError;
		expect(error.code).toBe("RUN_FAILED");
		expect(error.message).toContain("exit 3");
		expect(error.message).toContain("boom");
	});

	test("check: false returns a failed result instead of throwing", async () => {
		const result = await run("exit 2", { check: false });
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(2);
	});

	test("env is merged over process.env", async () => {
		const result = await run(`printf '%s|%s' "$WARDEN_RUN_TEST" "\${PATH:+has-path}"`, {
			env: { WARDEN_RUN_TEST: "yes" },
		});
		expect(result.stdout).toBe("yes|has-path");
	});

	test("cwd sets the working directory", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-run-")));
		const result = await run("pwd", { cwd: dir });
		expect(result.stdout.trim()).toBe(dir);
	});

	test("input is written to stdin", async () => {
		const result = await run("cat", { input: "piped" });
		expect(result.stdout).toBe("piped");
	});

	test("a command over its timeout is killed and throws TIMEOUT", async () => {
		const started = Date.now();
		const failure = await run("sleep 5", { timeout: 200 }).catch((error: unknown) => error);
		expect(Date.now() - started).toBeLessThan(3000);
		expect(failure instanceof E2eError && failure.code).toBe("TIMEOUT");
	});

	test("timeout takes a duration string", async () => {
		const failure = await run("sleep 5", { timeout: "200ms" }).catch((error: unknown) => error);
		expect(failure instanceof E2eError && failure.code).toBe("TIMEOUT");
	});

	test("a bad timeout throws INVALID_ARGUMENT", async () => {
		const failure = await run("true", { timeout: "soon" }).catch((error: unknown) => error);
		expect(failure instanceof E2eError && failure.code).toBe("INVALID_ARGUMENT");
	});

	test("an empty command throws INVALID_ARGUMENT", async () => {
		for (const command of ["", "   ", []]) {
			const failure = await run(command).catch((error: unknown) => error);
			expect(failure instanceof E2eError && failure.code).toBe("INVALID_ARGUMENT");
		}
	});

	test("a program that does not exist throws RUN_FAILED", async () => {
		const failure = await run(["warden-run-no-such-program"]).catch((error: unknown) => error);
		expect(failure instanceof E2eError && failure.code).toBe("RUN_FAILED");
	});

	test("inside an attempt it writes a `run` span with exit code, never the command", async () => {
		const events: TraceEvent[] = [];
		const sink = { write: (event: TraceEvent) => events.push(event) };
		const traced = createRun({ span: (op, fn, options) => runSpan(sink, op, fn, options) });
		await traced("echo secret-token");
		await traced("exit 4", { check: false });
		const spans = events.filter((event) => event.type === "span");
		expect(spans).toHaveLength(2);
		expect(spans[0]).toMatchObject({ op: "run", ok: true, detail: { exitCode: 0 } });
		expect(spans[1]).toMatchObject({ op: "run", ok: false, code: "RUN_FAILED", detail: { exitCode: 4 } });
		expect(JSON.stringify(events)).not.toContain("secret-token");
	});
});
