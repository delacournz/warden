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
		]) {
			expect(ok(line).success).toBe(false);
		}
	});

	test("a refusal says which subcommands are allowed", () => {
		const r = ok("warden gc --json");
		expect(!r.success && r.error).toContain("not allowed");
		expect(!r.success && r.error).toContain("claim");
	});
});
