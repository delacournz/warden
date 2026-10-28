import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@delacour/warden-core/types";
import { fakeExec, type TestContext, testContext } from "../testing";
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

	test("session-start prints one line when the disk is critically low, and exits 0", async () => {
		const c = setup(["session-start"], { session_id: "s1", hook_event_name: "SessionStart" });
		c.exec = fakeExec([
			[
				"df -Pk",
				{ stdout: "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/d 500000000 494000000 6000000 99% /" },
			],
		]);
		expect(await hookCommand.run(c)).toBe(0);
		expect(c.stdout).toHaveLength(1);
		expect(c.stdout[0]).toContain("disk 5.7G free");
		expect(c.stdout[0]).toContain("warden disk");
		expect(c.stderr).toEqual([]);
	});

	test("session-start prints nothing on a healthy disk, with bad stdin, or with WARDEN_DISK=off", async () => {
		const healthy = fakeExec([
			[
				"df -Pk",
				{ stdout: "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/d 500000000 1 400000000 1% /" },
			],
		]);
		const ok = setup(["session-start"], "{not json");
		ok.exec = healthy;
		expect(await hookCommand.run(ok)).toBe(0);
		expect(ok.stdout).toEqual([]);
		ok.cleanup();
		const off = setup(["session-start"], {});
		off.env.WARDEN_DISK = "off";
		off.exec = fakeExec([
			["df -Pk", { stdout: "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/d 500000000 1 1 99% /" }],
		]);
		expect(await hookCommand.run(off)).toBe(0);
		expect(off.stdout).toEqual([]);
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
		expect(await hookCommand.run(setup(["session-stop"], {}))).toBe(1);
	});
});
