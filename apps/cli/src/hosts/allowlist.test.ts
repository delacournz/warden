import { describe, expect, test } from "bun:test";
import { checkHostCommand } from "./allowlist";

const ok = (line: string) => checkHostCommand(line);

describe("checkHostCommand", () => {
	test("the allowed subcommands with --json pass, without the leading warden", () => {
		expect(ok("warden version --json")).toEqual({
			success: true,
			data: { argv: ["version", "--json"], name: "version" },
		});
		expect(ok("warden claim ios --json --idempotency-key k1 --ttl 90s")).toMatchObject({
			success: true,
			data: { name: "claim", argv: ["claim", "ios", "--json", "--idempotency-key", "k1", "--ttl", "90s"] },
		});
		for (const line of [
			"warden heartbeat L1 L2 --json",
			"warden release L1 --json",
			"warden ls --json",
			"warden doctor --leases --json",
			"/Users/x/.local/bin/warden ls --json",
			"warden port claim --from 8091 --ttl 90s --json",
			"warden port release --lease P1 --json",
			"warden __host-tunnel --port 8091 --lease P1 --json",
		]) {
			expect(ok(line).success).toBe(true);
		}
	});

	test("__driver-serve needs no --json (stdout is the protocol)", () => {
		expect(ok("warden __driver-serve --lease L1")).toMatchObject({ success: true, data: { name: "__driver-serve" } });
	});

	test("anything else is refused", () => {
		for (const line of [
			"",
			"bash",
			"sh -c 'rm -rf ~'",
			"warden",
			"warden gc --json",
			"warden host grant --key x --json",
			"warden sim delete --json",
			"warden claim ios",
			"warden doctor --fix --json",
			"warden doctor --fetch-helper --json",
			"warden release --session other --json",
			"warden heartbeat --session other --json",
			"warden release --all --json",
			"warden ls --json; rm -rf /",
			"warden 'ls",
			"warden __host-serve --key x",
			"warden port release 8091 --force --json",
			"warden port claim",
		]) {
			expect(ok(line).success).toBe(false);
		}
	});

	test("a refusal says which subcommands are allowed", () => {
		const r = ok("warden gc --json");
		expect(!r.success && r.error).toContain("not allowed");
		expect(!r.success && r.error).toContain("claim");
	});

	test("passthrough commands (warden host run): only their listed subcommands, --json optional", () => {
		for (const line of [
			"warden perf metrics --lease R1",
			"warden perf start --lease R1 --json",
			"warden golden ls",
			"warden golden ensure --json",
			"warden builds ls",
			"warden capacity",
			"warden queue --json",
			"warden __host-send --perf S1",
		]) {
			expect(ok(line).success).toBe(true);
		}
		for (const line of [
			"warden golden prune",
			"warden builds rm abc",
			"warden builds import /tmp/x.app",
			"warden builds",
			"warden perf start --udid U1",
			"warden perf start --claim",
			"warden perf start --lease R1 --allow-mutate-foreign",
		]) {
			expect(ok(line).success).toBe(false);
		}
		expect(ok("warden golden prune").success === false && ok("warden golden prune")).toMatchObject({
			error: expect.stringContaining("golden prune"),
		});
	});
});
