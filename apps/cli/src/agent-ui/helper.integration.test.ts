import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "@delacour/warden-core/store";
import type { Owner } from "@delacour/warden-core/types";
import { gcCommand } from "../commands/gc";
import { releaseCommand } from "../commands/release";
import { createUiCommand } from "../commands/ui";
import { handleSessionEnd } from "../hooks/claude-pretool";
import { OWNER_ENV } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { stopHelperAfter } from "./close";
import { defaultUiDeps } from "./driver";
import { defaultHelperDeps, ensureHelper, type HelperDeps, helperStatus, stopHelper } from "./helper";
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

	test("`warden release` stops the device's helper", async () => {
		const c = setup();
		const { socketPath } = await startHelper(c);
		const lease = c.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: UDID, name: "sim" }, owner: me, ttlMs: 3_600_000 },
			c.now()
		);
		c.argv = [lease.id];
		expect(await releaseCommand.run(c)).toBe(0);
		expect(c.db.listLeases()).toHaveLength(0);
		expect(existsSync(socketPath)).toBe(false);
		expect(readState(c, UDID).helper).toBeUndefined();
	});

	test("SessionEnd stops the helper of every device the session held", async () => {
		const c = setup();
		const { socketPath } = await startHelper(c);
		c.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: UDID, name: "sim" },
				owner: { ...me, sessionId: "s1" },
				ttlMs: 3_600_000,
			},
			c.now()
		);
		const res = await handleSessionEnd(
			{ session_id: "s1", reason: "other" },
			{
				store: () => c.db,
				now: c.now,
				pidAlive: () => true,
				gitInfo: () => undefined,
				deviceState: async () => undefined,
				shutdown: async () => ({ shutdown: [], notes: [] }),
				maybeGc: () => undefined,
				endInBackground: () => false,
				stopHelper: stopHelperAfter(c),
			}
		);
		expect(res.exitCode).toBe(0);
		expect(c.db.listLeases()).toHaveLength(0);
		expect(existsSync(socketPath)).toBe(false);
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
