import { afterEach, describe, expect, test } from "bun:test";
import { type HostRecord, putHost } from "@delacour/warden-core/hosts/registry";
import type { Owner } from "@delacour/warden-core/types";
import { type TestContext, testContext } from "../testing";
import { passthroughArgs, runPassthrough } from "./passthrough";

const ctxs: TestContext[] = [];
afterEach(() => {
	for (const ctx of ctxs.splice(0)) ctx.cleanup();
});

const OWNER: Owner = { kind: "agent", sessionId: "s1", cwd: "/repo" };
const HOST: HostRecord = { name: "mac", ssh: { hostname: "mac.tail" }, wardenPath: "/w/warden", addedAt: 1 };

function context(leases: { host: string; remote: string }[] = []): { ctx: TestContext; ids: string[] } {
	const ctx = testContext([]);
	ctxs.push(ctx);
	putHost(ctx.db, HOST);
	const ids = leases.map(
		(l) =>
			ctx.db.insertLease(
				{
					resource: {
						kind: "host-device",
						host: l.host,
						remoteLeaseId: l.remote,
						platform: "ios",
						id: `U-${l.remote}`,
						name: "iPhone",
					},
					owner: OWNER,
					ttlMs: 60_000,
				},
				0
			).id
	);
	return { ctx, ids };
}

describe("passthroughArgs", () => {
	test("a local host lease id becomes the host's id", () => {
		const { ctx, ids } = context([{ host: "mac", remote: "R1" }]);
		expect(passthroughArgs(ctx, OWNER, "mac", ["perf", "metrics", "--lease", ids[0] ?? ""])).toEqual({
			success: true,
			data: ["perf", "metrics", "--lease", "R1"],
		});
		expect(passthroughArgs(ctx, OWNER, "mac", ["perf", "metrics", `--lease=${ids[0]}`])).toMatchObject({
			data: ["perf", "metrics", "--lease=R1"],
		});
	});

	test("a device-bound perf call with no --lease gets the caller's only lease on that host", () => {
		const { ctx } = context([{ host: "mac", remote: "R1" }]);
		expect(passthroughArgs(ctx, OWNER, "mac", ["perf", "start", "--json"])).toMatchObject({
			data: ["perf", "start", "--json", "--lease", "R1"],
		});
		expect(passthroughArgs(ctx, OWNER, "mac", ["perf", "report", "S1"])).toMatchObject({
			data: ["perf", "report", "S1"],
		});
		expect(passthroughArgs(ctx, OWNER, "mac", ["golden", "ls"])).toMatchObject({ data: ["golden", "ls"] });
	});

	test("none or several leases on the host, or a lease on another host: the error says what to do", () => {
		const none = context();
		const r0 = passthroughArgs(none.ctx, OWNER, "mac", ["perf", "start"]);
		expect(!r0.success && r0.error).toContain("warden claim <platform> --host mac");
		const two = context([
			{ host: "mac", remote: "R1" },
			{ host: "mac", remote: "R2" },
		]);
		const r2 = passthroughArgs(two.ctx, OWNER, "mac", ["perf", "start"]);
		expect(!r2.success && r2.error).toContain("pass --lease");
		const other = context([{ host: "studio", remote: "R1" }]);
		const r3 = passthroughArgs(other.ctx, OWNER, "mac", ["perf", "start", "--lease", other.ids[0] ?? ""]);
		expect(!r3.success && r3.error).toContain("on studio, not mac");
	});
});

describe("runPassthrough", () => {
	test("runs the host's warden over ssh with a TTY when interactive, and passes its exit code back", async () => {
		const { ctx } = context();
		const seen: string[][] = [];
		const code = await runPassthrough(ctx, "mac", ["golden", "ls"], {
			tty: true,
			spawn: async (argv) => {
				seen.push([...argv]);
				return { exitCode: 3, stderr: "" };
			},
		});
		expect(code).toBe(3);
		expect(seen[0]).toContain("-t");
		expect(seen[0]?.slice(seen[0].indexOf("--") + 1)).toEqual(["/w/warden", "golden", "ls"]);
	});

	test("ssh's own failure is HOST_UNREACHABLE / HOST_AUTH with its exit code; an unknown host is HOST_UNKNOWN", async () => {
		const { ctx } = context();
		const down = await runPassthrough(ctx, "mac", ["golden", "ls"], {
			spawn: async () => ({ exitCode: 255, stderr: "ssh: connect to host mac.tail: Connection refused\n" }),
		});
		expect(down).toBe(12);
		expect(ctx.stderr.join("\n")).toContain("ssh could not reach the host");
		expect(await runPassthrough(ctx, "nope", ["golden", "ls"], {})).toBe(15);
	});
});
