import { afterEach, describe, expect, test } from "bun:test";
import type { ExecResult } from "@delacour/warden-core/exec";
import { type HostRecord, putHost } from "@delacour/warden-core/hosts/registry";
import type { Owner } from "@delacour/warden-core/types";
import { type TestContext, testContext } from "../testing";
import { claimOnHost, heartbeatHostLeases, hostClaimArgs, hostLeases, releaseHostLeases, remoteTtl } from "./claim";

const ctxs: TestContext[] = [];
afterEach(() => {
	for (const ctx of ctxs.splice(0)) ctx.cleanup();
});

type Handler = (remote: string[]) => Partial<ExecResult>;

/** An exec that answers ssh by the remote words after `--` (`claim ios …`), recording each remote argv. */
function hostExec(handler: Handler, remotes: string[][] = []) {
	return async (cmd: readonly string[]): Promise<ExecResult> => {
		const at = cmd.indexOf("--");
		const remote = cmd.slice(at + 1).slice(1);
		remotes.push(remote);
		return { exitCode: 0, stdout: "", stderr: "", ...handler(remote) };
	};
}

const HOST: HostRecord = {
	name: "mac",
	ssh: { user: "me", hostname: "mac.tail" },
	wardenPath: "/Users/me/.local/bin/warden",
	addedAt: 1,
};

const OWNER: Owner = { kind: "agent", sessionId: "s1", cwd: "/repo" };

function context(handler: Handler, remotes: string[][] = [], host: HostRecord = HOST): TestContext {
	const ctx = testContext([], { exec: hostExec(handler, remotes) });
	putHost(ctx.db, host);
	ctxs.push(ctx);
	return ctx;
}

const claimed = (n = 1) =>
	JSON.stringify(
		{
			leases: Array.from({ length: n }, (_, i) => ({
				leaseId: `R${i + 1}`,
				platform: "ios",
				udid: `UDID-${i + 1}`,
				name: `warden-iphone-${i + 1}`,
				action: "reuse",
				ttlMs: 90_000,
			})),
		},
		null,
		2
	);

const input = { host: "mac", platform: "ios" as const, owner: OWNER, ttlMs: 30 * 60_000 };

describe("remoteTtl", () => {
	test("WARDEN_REMOTE_TTL, else 90s", () => {
		expect(remoteTtl({})).toBe("90s");
		expect(remoteTtl({ WARDEN_REMOTE_TTL: "2m" })).toBe("2m");
		expect(remoteTtl({ WARDEN_REMOTE_TTL: " " })).toBe("90s");
	});
});

describe("hostClaimArgs", () => {
	test("passes the allocation flags on as typed; a default count is left out", () => {
		expect(hostClaimArgs({ count: "1" })).toEqual([]);
		expect(
			hostClaimArgs({ profile: "iphone-17", runtime: "26.5", count: "2", max: "4", wait: "5m", priority: "3" })
		).toEqual([
			"--profile",
			"iphone-17",
			"--runtime",
			"26.5",
			"--count",
			"2",
			"--max",
			"4",
			"--wait",
			"5m",
			"--priority",
			"3",
		]);
		expect(hostClaimArgs({ wait: false })).toEqual(["--no-wait"]);
	});
});

describe("claimOnHost", () => {
	test("runs the host's warden claim with a key and a short TTL, then records a host-device lease", async () => {
		const remotes: string[][] = [];
		const ctx = context(() => ({ stdout: claimed() }), remotes);
		const r = await claimOnHost(
			ctx,
			{ ...input, label: "ci", remoteArgs: ["--profile", "iphone"] },
			{ uuid: () => "K1" }
		);
		expect(r.success).toBe(true);
		expect(remotes[0]).toEqual([
			"claim",
			"ios",
			"--json",
			"--idempotency-key",
			"K1",
			"--ttl",
			"90s",
			"--label",
			"ci",
			"--profile",
			"iphone",
		]);
		const [lease] = hostLeases(ctx.db.listLeases());
		expect(lease?.resource).toEqual({
			kind: "host-device",
			host: "mac",
			remoteLeaseId: "R1",
			platform: "ios",
			id: "UDID-1",
			name: "warden-iphone-1",
		});
		expect(lease?.owner).toEqual(OWNER);
		expect(lease?.ttlMs).toBe(30 * 60_000);
		expect(lease?.label).toBe("ci");
		const events = ctx.db.listEvents().map((e) => e.type);
		expect(events).toContain("host_claimed");
	});

	test("the caller's idempotency key is reused, and an unreachable host is retried with it", async () => {
		const remotes: string[][] = [];
		let tries = 0;
		const ctx = context(() => {
			tries++;
			return tries < 3
				? { exitCode: 255, stderr: "ssh: connect to host mac.tail: Operation timed out" }
				: { stdout: claimed() };
		}, remotes);
		const r = await claimOnHost(ctx, { ...input, idempotencyKey: "mine", remoteArgs: [] }, { retryDelayMs: 0 });
		expect(r.success).toBe(true);
		expect(remotes).toHaveLength(3);
		for (const remote of remotes) expect(remote.slice(3, 5)).toEqual(["--idempotency-key", "mine"]);
	});

	test("three unreachable tries is HOST_UNREACHABLE; auth is not retried", async () => {
		const down = context(() => ({ exitCode: 255, stderr: "ssh: connect to host mac.tail: No route to host" }));
		const r = await claimOnHost(down, { ...input, remoteArgs: [] }, { retryDelayMs: 0 });
		expect(!r.success && r.error).toStartWith("HOST_UNREACHABLE: ");
		const remotes: string[][] = [];
		const denied = context(() => ({ exitCode: 255, stderr: "me@mac.tail: Permission denied (publickey)." }), remotes);
		const a = await claimOnHost(denied, { ...input, remoteArgs: [] }, { retryDelayMs: 0 });
		expect(!a.success && a.error).toStartWith("HOST_AUTH: ");
		expect(remotes).toHaveLength(1);
	});

	test("the host's coded claim failure keeps its code (and exit), prefixed with the host", async () => {
		const ctx = context(() => ({
			exitCode: 7,
			stdout: JSON.stringify({
				ok: false,
				command: "claim",
				error: { message: "no room", code: "NO_CAPACITY", capacityReason: "ram-budget" },
			}),
		}));
		const r = await claimOnHost(ctx, { ...input, remoteArgs: [] }, {});
		expect(!r.success && r.error).toBe("NO_CAPACITY[ram-budget]: mac: no room");
		expect(hostLeases(ctx.db.listLeases())).toHaveLength(0);
	});

	test("an unknown host is HOST_UNKNOWN", async () => {
		const ctx = context(() => ({}));
		const r = await claimOnHost(ctx, { ...input, host: "nope", remoteArgs: [] }, {});
		expect(!r.success && r.error).toStartWith("HOST_UNKNOWN: ");
	});

	test("a hosted Mac's session end caps the local TTL; a session already over refuses", async () => {
		const now = 1_000_000;
		const soon = context(() => ({ stdout: claimed() }), [], { ...HOST, expiresAt: now + 5 * 60_000 });
		await claimOnHost(soon, { ...input, remoteArgs: [] }, {});
		const [lease] = hostLeases(soon.db.listLeases());
		expect(lease?.ttlMs).toBe(5 * 60_000);
		expect(lease?.resource.expiresAt).toBe(now + 5 * 60_000);
		const over = context(() => ({ stdout: claimed() }), [], { ...HOST, expiresAt: now - 1 });
		const r = await claimOnHost(over, { ...input, remoteArgs: [] }, {});
		expect(!r.success && r.error).toContain("session ended");
	});

	test("the host's wait reasons are passed on; its JSON answer is not", async () => {
		const lines: string[] = [];
		const ctx = testContext([], {
			exec: async (_cmd, opts) => {
				for (const line of ["waiting: 2 ahead in the boot queue", ...claimed().split("\n")]) opts?.onLine?.(line);
				return { exitCode: 0, stdout: claimed(), stderr: "waiting: 2 ahead in the boot queue\n" };
			},
		});
		ctxs.push(ctx);
		putHost(ctx.db, HOST);
		await claimOnHost(ctx, { ...input, remoteArgs: [], onWait: (l) => lines.push(l) }, {});
		expect(lines).toEqual(["waiting: 2 ahead in the boot queue"]);
	});
});

describe("forwarding", () => {
	async function claimTwo(ctx: TestContext) {
		const r = await claimOnHost(ctx, { ...input, remoteArgs: ["--count", "2"] }, {});
		if (!r.success) throw new Error(r.error);
		return hostLeases(ctx.db.listLeases());
	}

	test("heartbeat renews the remote leases, one ssh per host", async () => {
		const remotes: string[][] = [];
		const ctx = context(
			(remote) =>
				remote[0] === "claim" ? { stdout: claimed(2) } : { stdout: '{"heartbeat":["R1","R2"],"unknown":[]}' },
			remotes
		);
		const leases = await claimTwo(ctx);
		expect(await heartbeatHostLeases(ctx, leases)).toEqual({ notes: [], gone: [], failed: [] });
		expect(remotes.at(-1)).toEqual(["heartbeat", "R1", "R2", "--json"]);
		expect(remotes).toHaveLength(2);
	});

	test("heartbeat reports leases the host no longer holds, and an unreachable host", async () => {
		let down = false;
		const ctx = context((remote) => {
			if (remote[0] === "claim") return { stdout: claimed(2) };
			if (down) return { exitCode: 255, stderr: "ssh: connect to host mac.tail: Connection refused" };
			return { exitCode: 1, stdout: '{"heartbeat":["R1"],"unknown":["R2"]}' };
		});
		const leases = await claimTwo(ctx);
		const gone = await heartbeatHostLeases(ctx, leases);
		expect(gone.gone.map((l) => l.resource.remoteLeaseId)).toEqual(["R2"]);
		down = true;
		const unreachable = await heartbeatHostLeases(ctx, leases);
		expect(unreachable.notes[0]).toContain("HOST_UNREACHABLE");
		expect(unreachable.gone).toEqual([]);
		expect(unreachable.failed).toEqual(["mac"]);
	});

	test("heartbeat warns 10 minutes before a hosted Mac's session ends", async () => {
		const ctx = context(
			(remote) => (remote[0] === "claim" ? { stdout: claimed() } : { stdout: '{"heartbeat":["R1"],"unknown":[]}' }),
			[],
			{ ...HOST, expiresAt: 1_000_000 + 9 * 60_000 }
		);
		const r = await claimOnHost(ctx, { ...input, remoteArgs: [] }, {});
		if (!r.success) throw new Error(r.error);
		const { notes } = await heartbeatHostLeases(ctx, hostLeases(ctx.db.listLeases()));
		expect(notes[0]).toContain("mac's session ends in 9m");
	});

	test("release forwards the remote ids (and --shutdown); an unreachable host is a note", async () => {
		const remotes: string[][] = [];
		let down = false;
		const ctx = context((remote) => {
			if (remote[0] === "claim") return { stdout: claimed(2) };
			if (down) return { exitCode: 255, stderr: "ssh: connect to host mac.tail: Connection refused" };
			return { stdout: '{"released":["R1","R2"]}' };
		}, remotes);
		const leases = await claimTwo(ctx);
		expect(await releaseHostLeases(ctx, leases, { shutdown: true })).toEqual({ released: ["R1", "R2"], notes: [] });
		expect(remotes.at(-1)).toEqual(["release", "R1", "R2", "--json", "--shutdown"]);
		down = true;
		const r = await releaseHostLeases(ctx, leases, {});
		expect(r.released).toEqual([]);
		expect(r.notes[0]).toContain("expires there on its own");
	});
});
