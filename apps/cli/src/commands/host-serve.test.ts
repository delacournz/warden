import { afterEach, describe, expect, test } from "bun:test";
import { putGrant } from "@delacour/warden-core/hosts/registry";
import type { Owner } from "@delacour/warden-core/types";
import { type TestContext, testContext } from "../testing";
import { createHostServeCommand, type HostServeSpawn } from "./host-serve";

const ctxs: TestContext[] = [];
afterEach(() => {
	for (const ctx of ctxs.splice(0)) ctx.cleanup();
});

type Spawned = { argv: string[]; env: Record<string, string | undefined> };

function setup(line: string | undefined, opts: { grant?: boolean; exit?: number } = {}) {
	const ctx = testContext(["--key", "SHA256:abc"]);
	ctxs.push(ctx);
	ctx.env = {
		...ctx.env,
		WARDEN_SESSION_ID: "laptop-session",
		CLAUDE_CODE_SESSION_ID: "x",
		CI: "true",
		...(line !== undefined ? { SSH_ORIGINAL_COMMAND: line } : {}),
	};
	if (opts.grant !== false) {
		putGrant(ctx.db, {
			fingerprint: "SHA256:abc",
			machineId: "m1",
			user: "chris",
			publicKey: "ssh-ed25519 AAA",
			addedAt: 0,
		});
	}
	const spawned: Spawned[] = [];
	const spawn: HostServeSpawn = async (argv, env) => {
		spawned.push({ argv: [...argv], env });
		return opts.exit ?? 0;
	};
	const run = () => createHostServeCommand({ spawn, self: ["/bin/warden"] }).run(ctx);
	return { ctx, spawned, run };
}

describe("warden __host-serve", () => {
	test("runs an allowed command as the granted key's host owner, never the caller's env owner", async () => {
		const { spawned, run } = setup("warden ls --json");
		expect(await run()).toBe(0);
		expect(spawned).toHaveLength(1);
		const [first] = spawned;
		expect(first?.argv).toEqual(["/bin/warden", "ls", "--json"]);
		expect(first?.env.WARDEN_HOST_OWNER).toBe('{"machineId":"m1","user":"chris"}');
		expect(first?.env.WARDEN_SESSION_ID).toBeUndefined();
		expect(first?.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
		expect(first?.env.CI).toBeUndefined();
		expect(first?.env.SSH_ORIGINAL_COMMAND).toBeUndefined();
	});

	test("passes the command's exit code through", async () => {
		const { run } = setup("warden claim ios --json --ttl 90s", { exit: 5 });
		expect(await run()).toBe(5);
	});

	test("a claim without --ttl gets WARDEN_REMOTE_TTL (default 90s)", async () => {
		const { spawned, run, ctx } = setup("warden claim ios --json");
		expect(await run()).toBe(0);
		expect(spawned[0]?.argv).toEqual(["/bin/warden", "claim", "ios", "--json", "--ttl", "90s"]);
		ctx.env.WARDEN_REMOTE_TTL = "2m";
		await run();
		expect(spawned[1]?.argv.slice(-2)).toEqual(["--ttl", "2m"]);
	});

	test("a key with no grant exits 2 and runs nothing", async () => {
		const { spawned, run, ctx } = setup("warden ls --json", { grant: false });
		expect(await run()).toBe(2);
		expect(spawned).toEqual([]);
		expect(ctx.stderr.join("\n")).toContain("not granted");
	});

	test("a refused command exits 2 and runs nothing", async () => {
		for (const line of ["bash", "warden gc --json", "warden release --session other --json", undefined]) {
			const { spawned, run } = setup(line);
			expect(await run()).toBe(2);
			expect(spawned).toEqual([]);
		}
	});

	test("release / heartbeat of a lease another owner holds is refused", async () => {
		const { ctx, spawned, run } = setup(undefined);
		const theirs = ctx.db.insertLease(
			{ resource: { kind: "port", port: 9000 }, owner: { kind: "agent", sessionId: "s", cwd: "/" }, ttlMs: 60_000 },
			ctx.now()
		);
		const mine = ctx.db.insertLease(
			{
				resource: { kind: "port", port: 9001 },
				owner: { kind: "host", machineId: "m1", user: "chris" },
				ttlMs: 60_000,
			},
			ctx.now()
		);
		ctx.env.SSH_ORIGINAL_COMMAND = `warden release ${mine.id} ${theirs.id} --json`;
		expect(await run()).toBe(2);
		expect(ctx.stderr.join("\n")).toContain(theirs.id);
		ctx.env.SSH_ORIGINAL_COMMAND = `warden heartbeat ${mine.id} --json`;
		expect(await run()).toBe(0);
		expect(spawned.map((s) => s.argv[1])).toEqual(["heartbeat"]);
	});

	test("perf acts only on the caller's own --lease; session reads need none", async () => {
		const withLease = (owner: Owner) => {
			const h = setup(undefined);
			const lease = h.ctx.db.insertLease(
				{ resource: { kind: "device", platform: "ios", id: "U1", name: "iPhone" }, owner, ttlMs: 90_000 },
				0
			);
			h.ctx.env.SSH_ORIGINAL_COMMAND = `warden perf metrics --lease ${lease.id}`;
			return h;
		};
		expect(await withLease({ kind: "host", machineId: "m1", user: "chris" }).run()).toBe(0);
		const foreign = withLease({ kind: "user", pid: 1, cwd: "/" });
		expect(await foreign.run()).toBe(2);
		expect(foreign.spawned).toHaveLength(0);
		const none = setup("warden perf metrics");
		expect(await none.run()).toBe(2);
		expect(none.ctx.stderr.join("\n")).toContain("needs --lease");
		const unknown = setup("warden perf metrics --lease nope");
		expect(await unknown.run()).toBe(2);
		expect(await setup("warden perf report S1 --json").run()).toBe(0);
	});

	test("--relay-owner (host serve --uplink): the relay's owner, never with --key, malformed refused", async () => {
		const relayed = setup("warden ls --json", { grant: false });
		relayed.ctx.argv = ["--relay-owner", '{"machineId":"m9","user":"me@x.nz"}'];
		expect(await relayed.run()).toBe(0);
		expect(relayed.spawned[0]?.env.WARDEN_HOST_OWNER).toBe('{"machineId":"m9","user":"me@x.nz"}');
		const bad = setup("warden ls --json", { grant: false });
		bad.ctx.argv = ["--relay-owner", "{}"];
		expect(await bad.run()).toBe(1);
		const both = setup("warden ls --json");
		both.ctx.argv = ["--key", "SHA256:abc", "--relay-owner", '{"machineId":"m9","user":"u"}'];
		expect(await both.run()).toBe(1);
		expect(both.spawned).toHaveLength(0);
	});
});

describe("warden __host-serve: host attach's live log", () => {
	test("appends one entry per call (refusals too) when WARDEN_HOST_SERVE_LOG is set, and never passes it on", async () => {
		const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "serve-log-"));
		try {
			const log = join(dir, "serve.log");
			const ok = setup("warden ls --json");
			ok.ctx.env.WARDEN_HOST_SERVE_LOG = log;
			expect(await ok.run()).toBe(0);
			expect(ok.spawned[0]?.env.WARDEN_HOST_SERVE_LOG).toBeUndefined();
			const no = setup("warden doctor --fix --json");
			no.ctx.env.WARDEN_HOST_SERVE_LOG = log;
			expect(await no.run()).toBe(2);
			const lines = readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
			expect(lines[0]).toMatchObject({ machineId: "m1", user: "chris", argv: ["ls", "--json"] });
			expect(lines[1]).toMatchObject({ user: "chris", argv: ["doctor", "--fix", "--json"] });
			expect(lines[1].refused).toContain("refused");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("no log env, no file", async () => {
		const { spawned, run } = setup("warden ls --json");
		expect(await run()).toBe(0);
		expect(spawned).toHaveLength(1);
	});
});
