import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "@delacour/warden-core/store";
import type { Owner } from "@delacour/warden-core/types";
import { gcCommand } from "../commands/gc";
import { hookCommand } from "../commands/hook";
import { releaseCommand } from "../commands/release";
import { createUiCommand } from "../commands/ui";
import { OWNER_ENV } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { defaultUiDeps } from "./driver";
import {
	defaultHelperDeps,
	ensureHelper,
	type HelperDeps,
	helperStatus,
	ownerKey,
	simdEnvKey,
	stopHelper,
} from "./helper";
import { readState } from "./state";

/**
 * Real processes: `native/scripts/fake-simd.ts --socket` stands in for the `warden-simd` daemon. Unix socket
 * paths are capped at 104 bytes, so everything lives under a short `/tmp/wdn-*` directory.
 */

const FAKE = join(import.meta.dir, "../../../../packages/e2e/native/scripts/fake-simd.ts");
const FIXTURE = join(import.meta.dir, "helper.race-fixture.ts");
const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const me: Owner = { kind: "agent", sessionId: "me", cwd: "/w" };

let dir: string;
let ctx: TestContext | undefined;
let pids: number[] = [];

beforeEach(() => {
	dir = mkdtempSync("/tmp/wdn-");
	mkdirSync(join(dir, "simd"), { recursive: true });
});

afterEach(() => {
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	pids = [];
	ctx?.cleanup();
	ctx = undefined;
	rmSync(dir, { recursive: true, force: true });
});

const script = (body: object = {}): string => {
	const path = join(dir, `script-${readdirSync(dir).length}.json`);
	writeFileSync(path, JSON.stringify(body));
	return path;
};

/** The default detached spawn, but running the fake helper script instead of a `warden-simd` binary. */
function fakeDeps(scriptPath: string): HelperDeps {
	return {
		...defaultHelperDeps,
		spawnDetached: (spec) => {
			const out = defaultHelperDeps.spawnDetached({
				cmd: [process.execPath, FAKE, "--script", scriptPath, ...spec.cmd.slice(1)],
				logPath: spec.logPath,
				signalMs: spec.signalMs,
			});
			pids.push(out.pid);
			return out;
		},
	};
}

function setup(argv: string[] = []): TestContext {
	ctx = testContext(argv);
	ctx.env = { ...ctx.env, ...OWNER_ENV, WARDEN_HOME: dir };
	return ctx;
}

async function startHelper(c: TestContext, body: object = {}) {
	const socketPath = join(dir, "simd", `${UDID}.sock`);
	const deps = fakeDeps(script(body));
	const res = await ensureHelper(c, UDID, { socketPath, helperPath: "/fake/warden-simd", deps });
	if (!res.success) throw new Error(res.error.message);
	return { socketPath, deps, info: res.data };
}

describe("helper lifecycle (real fake-simd --socket)", () => {
	test("concurrent ensureHelper from several processes spawn exactly one helper", async () => {
		const marks = join(dir, "marks");
		mkdirSync(marks);
		const socketPath = join(dir, "simd", `${UDID}.sock`);
		openStore(join(dir, "warden.db")).close();
		const startAt = Date.now() + 600;
		const procs = Array.from({ length: 4 }, () =>
			Bun.spawn(["bun", FIXTURE, dir, UDID, socketPath, script(), marks, String(startAt)], {
				stdout: "pipe",
				stderr: "inherit",
			})
		);
		const outs = await Promise.all(procs.map(async (p) => JSON.parse((await new Response(p.stdout).text()).trim())));
		expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0]);
		expect(outs.every((o) => o.ok === true)).toBe(true);
		expect(readdirSync(marks)).toHaveLength(1);
		expect(outs.filter((o) => o.spawned)).toHaveLength(1);
		const pid = JSON.parse(readFileTextSafe(join(dir, "ui", UDID, "state.json"))).helper.pid;
		pids.push(pid);
		const c = setup();
		expect(helperStatus(c, UDID)).toMatchObject({ running: true, pid });
		expect((await stopHelper(c, UDID)).stopped).toBe(true);
	});

	test("a stale socket file with nobody behind it is replaced by a live helper", async () => {
		const c = setup();
		const socketPath = join(dir, "simd", `${UDID}.sock`);
		writeFileSync(socketPath, "stale");
		const started = await startHelper(c);
		expect(started.info.spawned).toBe(true);
		expect(existsSync(socketPath)).toBe(true);
		const again = await ensureHelper(c, UDID, { socketPath, helperPath: "/fake/warden-simd", deps: started.deps });
		expect(again).toMatchObject({ success: true, data: { spawned: false } });
	});

	test("stopHelper: shutdown → the helper exits and removes its socket; a second call is a no-op", async () => {
		const c = setup();
		const { socketPath } = await startHelper(c);
		const began = Date.now();
		expect(await stopHelper(c, UDID)).toEqual({ stopped: true, how: "shutdown" });
		expect(Date.now() - began).toBeLessThan(1500);
		expect(existsSync(socketPath)).toBe(false);
		expect(readState(c, UDID).helper).toBeUndefined();
		expect(await stopHelper(c, UDID)).toEqual({ stopped: false, how: "none" });
	});

	test("`warden ui close` finishes within 2.5 s even when the helper ignores shutdown (SIGTERM fallback)", async () => {
		const c = setup();
		const { socketPath, info } = await startHelper(c, { ops: { shutdown: { ignore: true } } });
		c.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: UDID, name: "sim" }, owner: me, ttlMs: 3_600_000 },
			c.now()
		);
		c.argv = ["close", "--udid", UDID, "--json"];
		const began = Date.now();
		expect(await createUiCommand(defaultUiDeps).run(c)).toBe(0);
		expect(Date.now() - began).toBeLessThan(2500);
		expect(JSON.parse(c.stdout.join("\n")).result.helper).toEqual({ stopped: true, how: "sigterm" });
		expect(existsSync(socketPath)).toBe(false);
		expect(() => process.kill(info.pid ?? 0, 0)).toThrow();
		expect(c.db.listLeases()).toHaveLength(1);
	});

	test("`warden ui close --release` releases the lease and stops the helper", async () => {
		const c = setup();
		const { socketPath } = await startHelper(c);
		c.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: UDID, name: "sim" }, owner: me, ttlMs: 3_600_000 },
			c.now()
		);
		c.argv = ["close", "--release", "--udid", UDID];
		expect(await createUiCommand(defaultUiDeps).run(c)).toBe(0);
		expect(c.db.listLeases()).toHaveLength(0);
		expect(existsSync(socketPath)).toBe(false);
	});

	test("`warden release` leaves the helper resident: same pid, socket still answering, status running", async () => {
		const c = setup();
		const { socketPath, info } = await startHelper(c);
		const lease = c.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: UDID, name: "sim" }, owner: me, ttlMs: 3_600_000 },
			c.now()
		);
		c.argv = [lease.id];
		expect(await releaseCommand.run(c)).toBe(0);
		expect(c.db.listLeases()).toHaveLength(0);
		expect(existsSync(socketPath)).toBe(true);
		expect(helperStatus(c, UDID)).toMatchObject({ running: true, pid: info.pid });
		expect(readState(c, UDID).helper).toMatchObject({ pid: info.pid });
	});

	test("`warden release --shutdown` stops the helper and forgets it", async () => {
		const c = setup();
		const { socketPath } = await startHelper(c);
		const lease = c.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: UDID, name: "sim" }, owner: me, ttlMs: 3_600_000 },
			c.now()
		);
		c.argv = ["--shutdown", lease.id];
		expect(await releaseCommand.run(c)).toBe(0);
		expect(c.db.listLeases()).toHaveLength(0);
		expect(existsSync(socketPath)).toBe(false);
		expect(readState(c, UDID).helper).toBeUndefined();
	});

	test("SessionEnd releases the session's leases but leaves the device's helper resident", async () => {
		const c = setup();
		c.env = { ...c.env, WARDEN_BACKGROUND: "0" };
		c.readStdin = async () => JSON.stringify({ session_id: "s1", reason: "other" });
		c.argv = ["session-end"];
		const { socketPath } = await startHelper(c);
		c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: UDID, name: "sim" },
				owner: { ...me, sessionId: "s1" },
				ttlMs: 3_600_000,
			},
			c.now()
		);
		expect(await hookCommand.run(c)).toBe(0);
		expect(c.db.listLeases()).toHaveLength(0);
		expect(existsSync(socketPath)).toBe(true);
	});

	test("the next run on the device reuses the resident helper: same pid, nothing spawned", async () => {
		const c = setup();
		const first = await startHelper(c);
		const connects = { spawnedAgain: 0 };
		const deps: HelperDeps = {
			...first.deps,
			spawnDetached: (spec) => {
				connects.spawnedAgain += 1;
				return first.deps.spawnDetached(spec);
			},
		};
		const again = await ensureHelper(c, UDID, {
			socketPath: first.socketPath,
			helperPath: "/fake/warden-simd",
			keepClient: true,
			deps,
		});
		expect(again).toMatchObject({ success: true, data: { spawned: false } });
		expect(connects.spawnedAgain).toBe(0);
		if (again.success) await again.data.client?.close();
		expect(helperStatus(c, UDID).pid).toBe(first.info.pid ?? null);
	});

	test("the lease passing to another owner keeps the resident helper; a changed WARDEN_SIMD_* env replaces it", async () => {
		const c = setup();
		const a: Owner = { kind: "user", pid: 1, cwd: "/w" };
		const b: Owner = { kind: "user", pid: 2, cwd: "/w" };
		const lease = c.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: UDID, name: "sim" }, owner: a, ttlMs: 3_600_000 },
			c.now()
		);
		const first = await startHelper(c);
		expect(readState(c, UDID).helper?.owner).toBe(ownerKey(a));
		c.db.deleteLeases([lease.id]);
		c.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: UDID, name: "sim" }, owner: b, ttlMs: 3_600_000 },
			c.now()
		);
		const kept = await ensureHelper(c, UDID, {
			socketPath: first.socketPath,
			helperPath: "/fake/warden-simd",
			deps: first.deps,
		});
		expect(kept).toMatchObject({ success: true, data: { spawned: false } });
		expect(helperStatus(c, UDID).pid).toBe(first.info.pid ?? null);

		c.env = { ...c.env, WARDEN_SIMD_PACE_MS: "40" };
		const second = await ensureHelper(c, UDID, {
			socketPath: first.socketPath,
			helperPath: "/fake/warden-simd",
			deps: first.deps,
		});
		expect(second).toMatchObject({ success: true, data: { spawned: true } });
		expect(second.success && second.data.pid).not.toBe(first.info.pid);
		expect(() => process.kill(first.info.pid ?? 0, 0)).toThrow();
		expect(readState(c, UDID).helper?.env).toBe(simdEnvKey(c.env));
	});

	test("a resident helper slow to send `ready` (busy) is waited for, not replaced: same pid, nothing spawned", async () => {
		const c = setup();
		// the 2nd and 3rd connections' ready comes 3 s late, past the client's 2 s handshake timeout; later ones are prompt
		const first = await startHelper(c, { readyDelay: { ms: 3000, connections: [2, 3] } });
		const spawns = { count: 0 };
		const deps: HelperDeps = {
			...first.deps,
			spawnDetached: (spec) => {
				spawns.count += 1;
				return first.deps.spawnDetached(spec);
			},
		};
		const again = await ensureHelper(c, UDID, { socketPath: first.socketPath, helperPath: "/fake/warden-simd", deps });
		expect(again).toMatchObject({ success: true, data: { spawned: false } });
		expect(spawns.count).toBe(0);
		expect(helperStatus(c, UDID)).toMatchObject({ running: true, pid: first.info.pid });
	}, 10_000);

	/** `ensureHelper` against a fake helper that announces itself as `announce`; counts connects made after the spawn. */
	async function startAnnouncing(announce: "ready" | "legacy" | "none") {
		const c = setup();
		const socketPath = join(dir, "simd", `${UDID}.sock`);
		const seen = { connectsAfterSpawn: 0, spawned: false };
		const base = fakeDeps(script({ announce }));
		const deps: HelperDeps = {
			...base,
			connect: (path) => {
				if (seen.spawned) seen.connectsAfterSpawn += 1;
				return base.connect(path);
			},
			spawnDetached: (spec) => {
				seen.spawned = true;
				return base.spawnDetached(spec);
			},
		};
		const began = Date.now();
		const res = await ensureHelper(c, UDID, { socketPath, helperPath: "/fake/warden-simd", deps });
		return { c, res, seen, ms: Date.now() - began };
	}

	test("a helper that prints its ready line is connected to once, right after the spawn", async () => {
		const { c, res, seen } = await startAnnouncing("ready");
		expect(res).toMatchObject({ success: true, data: { spawned: true } });
		expect(seen.connectsAfterSpawn).toBe(1);
		expect(readState(c, UDID).helper?.pid).toBeGreaterThan(0);
	});

	test("an older helper that only logs `listening on …` is just as fast", async () => {
		const { res, seen } = await startAnnouncing("legacy");
		expect(res).toMatchObject({ success: true, data: { spawned: true } });
		expect(seen.connectsAfterSpawn).toBe(1);
	});

	test("a helper that prints nothing still starts: the socket poll takes over after the signal wait", async () => {
		const { res, ms } = await startAnnouncing("none");
		expect(res).toMatchObject({ success: true, data: { spawned: true } });
		expect(ms).toBeLessThan(4000);
	});

	test("gc removes the socket of a helper whose recorded pid is dead", async () => {
		const c = setup(["--json"]);
		const socketPath = join(dir, "simd", `${UDID}.sock`);
		writeFileSync(socketPath, "");
		const { writeState } = await import("./state");
		writeState(c, UDID, { generation: 0, updatedAt: 0, helper: { pid: 2_000_000_000, socket: socketPath } });
		expect(await gcCommand.run(c)).toBe(0);
		expect(existsSync(socketPath)).toBe(false);
		expect(readState(c, UDID).helper).toBeUndefined();
	});
});

function readFileTextSafe(path: string): string {
	return require("node:fs").readFileSync(path, "utf8");
}
