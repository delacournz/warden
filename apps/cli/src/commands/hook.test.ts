import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@warden/core/types";
import { type TestContext, testContext } from "../testing";
import { hookCommand } from "./hook";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const other: Owner = { kind: "agent", sessionId: "s2", cwd: "/x" };

function setup(argv: string[], stdin: unknown): TestContext {
	ctx = testContext(argv, { readStdin: async () => (typeof stdin === "string" ? stdin : JSON.stringify(stdin)) });
	return ctx;
}

const pretool = (udid: string) => ({
	session_id: "s1",
	cwd: "/nonexistent",
	hook_event_name: "PreToolUse",
	tool_name: "mcp__argent__describe",
	tool_input: { udid },
});

describe("warden hook", () => {
	test("pretool leases a free device and exits 0", async () => {
		const c = setup(["pretool"], pretool(UDID));
		expect(await hookCommand.run(c)).toBe(0);
		expect(c.db.listLeases()[0]?.owner).toMatchObject({ kind: "agent", sessionId: "s1" });
	});

	test("pretool blocks a device leased by another session with exit 2 + stderr", async () => {
		const c = setup(["pretool"], pretool(UDID));
		c.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: UDID, name: "s" }, owner: other, ttlMs: 60_000 },
			c.now()
		);
		expect(await hookCommand.run(c)).toBe(2);
		expect(c.stderr.join("\n")).toContain(`device ${UDID} leased by agent s2`);
	});

	test("bad JSON never blocks", async () => {
		const c = setup(["pretool"], "{not json");
		expect(await hookCommand.run(c)).toBe(0);
		expect(c.stderr.join("\n")).toContain("warden hook pretool");
	});

	test("session-end releases the session's leases", async () => {
		const c = setup(["session-end"], { session_id: "s1", hook_event_name: "SessionEnd" });
		c.db.insertLease(
			{ resource: { kind: "port", port: 8091 }, owner: { kind: "agent", sessionId: "s1", cwd: "/" }, ttlMs: 1 },
			c.now()
		);
		c.db.insertLease({ resource: { kind: "port", port: 8092 }, owner: other, ttlMs: 1 }, c.now());
		expect(await hookCommand.run(c)).toBe(0);
		expect(c.db.listLeases().map((l) => l.owner)).toEqual([other]);
	});

	test("unknown / missing subcommand → commander usage error, exit 1, nothing on stdout", async () => {
		const missing = setup([], {});
		expect(await hookCommand.run(missing)).toBe(1);
		expect(missing.stdout).toEqual([]);
		expect(missing.stderr.join("\n")).toContain("pretool");
		missing.cleanup();
		const unknown = setup(["nope"], {});
		expect(await hookCommand.run(unknown)).toBe(1);
		expect(unknown.stderr.join("\n")).toContain("unknown command 'nope'");
		unknown.cleanup();
		expect(await hookCommand.run(setup(["session-start"], {}))).toBe(1);
	});

	test("allowed tool call prints nothing", async () => {
		const c = setup(["pretool"], { ...pretool(UDID), tool_name: "Bash", tool_input: { command: "ls" } });
		expect(await hookCommand.run(c)).toBe(0);
		expect(c.stdout).toEqual([]);
		expect(c.stderr).toEqual([]);
	});
});
