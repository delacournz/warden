import { describe, expect, test } from "bun:test";
import { fakeExec } from "@delacour/warden-e2e-bench/src/harness/exec";
import { checkArgs, runChecks, splitSelector } from "./check";

describe("splitSelector", () => {
	test("keeps quoted text as one argument", () => {
		expect(splitSelector('text "ada@example.com"')).toEqual(["text", "ada@example.com"]);
		expect(splitSelector("id=todos-screen")).toEqual(["id=todos-screen"]);
		expect(splitSelector("role=button name='Sign in'")).toEqual(["role=button", "name=Sign in"]);
	});
});

describe("checkArgs", () => {
	test("maps each check to its warden ui call", () => {
		expect(checkArgs({ wait: "id=a" }, "U")).toEqual(["ui", "wait", "id=a", "--udid", "U", "--timeout", "5000"]);
		expect(checkArgs({ absent: "id=a", timeoutMs: 900 }, "U")).toEqual([
			"ui",
			"wait",
			"absent",
			"id=a",
			"--udid",
			"U",
			"--timeout",
			"900",
		]);
		expect(checkArgs({ is: "id=s", state: "checked" }, "U")).toEqual(["ui", "is", "id=s", "checked", "--udid", "U"]);
	});
});

describe("runChecks", () => {
	test("passes only when every check exits 0, and runs them all", async () => {
		const exec = fakeExec([
			{ cmd: "/bun", match: (a) => a.includes("wait"), result: { code: 0, stdout: "ok" } },
			{ cmd: "/bun", match: (a) => a.includes("is"), result: { code: 1, stdout: "false" } },
		]);
		const out = await runChecks(exec, {
			checks: [{ wait: "id=a" }, { is: "id=s", state: "checked" }],
			udid: "U",
			bunPath: "/bun",
			cliPath: "/cli.ts",
			env: { WARDEN_SESSION_ID: "s" },
		});
		expect(out.passed).toBe(false);
		expect(out.results.map((r) => r.passed)).toEqual([true, false]);
		expect(exec.calls[0]?.args.slice(0, 3)).toEqual(["/cli.ts", "ui", "wait"]);
		expect(exec.calls[0]?.options?.env?.WARDEN_SESSION_ID).toBe("s");
	});
});
