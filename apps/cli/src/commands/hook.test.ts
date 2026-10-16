import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@delacour/warden-core/types";
import { type TestContext, testContext } from "../testing";
import { hookCommand } from "./hook";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const other: Owner = { kind: "agent", sessionId: "s2", cwd: "/x" };

function setup(argv: string[], stdin: unknown): TestContext {
	ctx = testContext(argv, { readStdin: async () => (typeof stdin === "string" ? stdin : JSON.stringify(stdin)) });
	return ctx;
}

describe("warden hook", () => {
	test("pretool is a silent no-op, so hooks installed by older versions keep working", async () => {
		const c = setup(["pretool"], { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } });
		expect(await hookCommand.run(c)).toBe(0);
		expect(c.stdout).toEqual([]);
		expect(c.stderr).toEqual([]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("bad JSON never blocks", async () => {
		const c = setup(["session-end"], "{not json");
		expect(await hookCommand.run(c)).toBe(0);
		expect(c.stderr.join("\n")).toContain("warden hook session-end");
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
		expect(missing.stderr.join("\n")).toContain("session-end");
		missing.cleanup();
		const unknown = setup(["nope"], {});
		expect(await hookCommand.run(unknown)).toBe(1);
		expect(unknown.stderr.join("\n")).toContain("unknown command 'nope'");
		unknown.cleanup();
		expect(await hookCommand.run(setup(["session-start"], {}))).toBe(1);
	});
});
