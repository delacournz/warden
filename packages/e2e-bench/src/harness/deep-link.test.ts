import { describe, expect, test } from "bun:test";
import { PRIME_LINK, primeDeepLink } from "./deep-link";
import { fakeExec } from "./exec";

const input = (exec: ReturnType<typeof fakeExec>) => ({
	exec,
	platform: "ios" as const,
	udid: "UDID-1",
	bundleId: "com.example.app",
	repoRoot: "/repo",
	cliPath: "/repo/apps/cli/src/cli.ts",
});

describe("primeDeepLink", () => {
	test("iOS: opens one link with warden's opener, stops the helper and the app, in that order", async () => {
		const exec = fakeExec([
			{ cmd: "bun", result: { stdout: '{"ok":true}' } },
			{ cmd: "xcrun", result: {} },
		]);
		const outcome = await primeDeepLink(input(exec));
		expect(outcome).toEqual({ primed: true, detail: `opened ${PRIME_LINK}` });
		expect(exec.calls.map((c) => [c.cmd, ...c.args])).toEqual([
			["bun", "/repo/apps/cli/src/cli.ts", "ui", "open", PRIME_LINK, "--udid", "UDID-1", "--json"],
			["bun", "/repo/apps/cli/src/cli.ts", "ui", "close", "--udid", "UDID-1"],
			["xcrun", "simctl", "terminate", "UDID-1", "com.example.app"],
		]);
		expect(exec.calls[0]?.options).toEqual({ cwd: "/repo", timeoutMs: 60_000 });
	});

	test("a failed open is reported, not thrown, and the helper and app are still stopped", async () => {
		const exec = fakeExec([
			{ cmd: "bun", match: (a) => a[2] === "open", result: { code: 1, stderr: "no lease for UDID-1\n" } },
			{ cmd: "bun", result: {} },
			{ cmd: "xcrun", result: { code: 3, stderr: "Unable to terminate: not running\n" } },
		]);
		const outcome = await primeDeepLink(input(exec));
		expect(outcome.primed).toBe(false);
		expect(outcome.detail).toBe("open: no lease for UDID-1");
		expect(exec.calls).toHaveLength(3);
	});

	test("android: nothing to prime, no command runs", async () => {
		const exec = fakeExec();
		const outcome = await primeDeepLink({ ...input(exec), platform: "android" });
		expect(outcome).toEqual({ primed: false, detail: "ios only" });
		expect(exec.calls).toEqual([]);
	});
});
