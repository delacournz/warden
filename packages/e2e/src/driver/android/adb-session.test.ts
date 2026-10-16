import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collectSpanDetail, type SpanDetail } from "../span-detail";
import { type AdbSession, openAdbSession, type SpawnAdb, spawnAdb } from "./adb-session";

const FAKE_ADB = join(import.meta.dir, "../../../native/scripts/fake-adb.ts");

const sessions: AdbSession[] = [];

function open(opts: { spawn?: SpawnAdb; log?: (line: string) => void } = {}): AdbSession {
	const session = openAdbSession({ adb: FAKE_ADB, serial: "emulator-5554", ...opts });
	sessions.push(session);
	return session;
}

afterEach(async () => {
	await Promise.all(sessions.splice(0).map((s) => s.close()));
});

async function data<T>(
	promise: Promise<{ success: true; data: T } | { success: false; error: { code: string } }>
): Promise<T> {
	const result = await promise;
	if (!result.success) throw new Error(`unexpected error ${result.error.code}`);
	return result.data;
}

describe("adb session span detail", () => {
	test("commands run inside a span add their count and time to its detail", async () => {
		const s = open();
		const notes: SpanDetail = {};
		await collectSpanDetail(notes, async () => {
			await s.run("echo one");
			await s.run("echo two");
		});
		expect(notes.adbCalls).toBe(2);
		expect(typeof notes.adbMs).toBe("number");
		expect(notes.adbMs).toBeGreaterThanOrEqual(0);
	});

	test("outside a span nothing is recorded and nothing breaks", async () => {
		const s = open();
		expect(await data(s.run("echo hi"))).toEqual({ stdout: "hi\n", exitCode: 0 });
	});
});

describe("adb session", () => {
	test("runs a command and returns stdout + exit code", async () => {
		const s = open();
		expect(await data(s.run("echo hello world"))).toEqual({ stdout: "hello world\n", exitCode: 0 });
	});

	test("starts adb as `adb -s <serial> shell`", async () => {
		const s = open();
		expect((await data(s.run("args"))).stdout).toBe("-s emulator-5554 shell\n");
	});

	test("propagates a non-zero exit code", async () => {
		const s = open();
		expect(await data(s.run("fail 3"))).toEqual({ stdout: "", exitCode: 3 });
		expect((await data(s.run("nosuchcmd"))).exitCode).toBe(127);
	});

	test("output without a trailing newline is split cleanly from the sentinel", async () => {
		const s = open();
		expect(await data(s.run("raw no-newline"))).toEqual({ stdout: "no-newline", exitCode: 0 });
	});

	test("a sentinel split across reads is still found", async () => {
		const s = open();
		expect(await data(s.run("split partial"))).toEqual({ stdout: "partial\n", exitCode: 0 });
	});

	test("a sentinel-shaped line for another id is ordinary output", async () => {
		const s = open();
		expect(await data(s.run("decoy"))).toEqual({ stdout: "__WDN_other_0__\n", exitCode: 0 });
	});

	test("large output", async () => {
		const s = open();
		const out = await data(s.run("big 200000"));
		expect(out.stdout.length).toBe(200_001);
		expect(out.exitCode).toBe(0);
	});

	test("commands run FIFO, one in flight, on one process", async () => {
		const s = open();
		const order: string[] = [];
		const tag = (name: string) => (r: Awaited<ReturnType<AdbSession["run"]>>) => {
			order.push(name);
			return r;
		};
		const results = await Promise.all([
			s.run("sleep 120").then(tag("a")),
			s.run("echo b").then(tag("b")),
			s.run("echo c").then(tag("c")),
			s.run("pid"),
			s.run("pid"),
		]);
		expect(order).toEqual(["a", "b", "c"]);
		const [, b, c, p1, p2] = results;
		expect(b?.success && b.data.stdout).toBe("b\n");
		expect(c?.success && c.data.stdout).toBe("c\n");
		expect(p1?.success && p1.data.stdout).toBe(p2?.success && p2.data.stdout);
	});

	test("a timeout returns E_TIMEOUT, kills the shell and the next command gets a fresh one", async () => {
		const s = open();
		const pid1 = (await data(s.run("pid"))).stdout;
		const timedOut = await s.run("sleep 600000", { timeoutMs: 150 });
		expect(timedOut.success).toBe(false);
		if (!timedOut.success) {
			expect(timedOut.error.code).toBe("E_TIMEOUT");
			expect(timedOut.error.retryable).toBe(true);
		}
		const pid2 = (await data(s.run("pid"))).stdout;
		expect(pid2).not.toBe(pid1);
	});

	test("a stale reply from a timed-out command never leaks into the next one", async () => {
		const s = open();
		await s.run("sleep 300", { timeoutMs: 100 });
		expect(await data(s.run("echo fresh"))).toEqual({ stdout: "fresh\n", exitCode: 0 });
	});

	test("a process that dies mid-command gives E_HELPER_CRASHED, then respawns for the next command", async () => {
		const s = open();
		const pid1 = (await data(s.run("pid"))).stdout;
		const crashed = await s.run("crash-after partial");
		expect(crashed.success).toBe(false);
		if (!crashed.success) {
			expect(crashed.error.code).toBe("E_HELPER_CRASHED");
			expect(crashed.error.retryable).toBe(true);
		}
		const pid2 = (await data(s.run("pid"))).stdout;
		expect(pid2).not.toBe(pid1);
		expect((await data(s.run("echo back"))).stdout).toBe("back\n");
	});

	test("scripted `exit` kills the process without a sentinel", async () => {
		const s = open();
		const r = await s.run("exit 9");
		expect(!r.success && r.error.code).toBe("E_HELPER_CRASHED");
		expect((await data(s.run("echo ok"))).stdout).toBe("ok\n");
	});

	test("commands queued behind a crash run on the respawned shell", async () => {
		const s = open();
		const [crash, after] = await Promise.all([s.run("exit 1"), s.run("echo after")]);
		expect(!crash.success && crash.error.code).toBe("E_HELPER_CRASHED");
		expect(after.success && after.data.stdout).toBe("after\n");
	});

	test("respawns once: a respawn that also dies makes the session give up", async () => {
		let spawns = 0;
		const s = open({
			spawn: (argv) => {
				spawns++;
				return spawnAdb(argv, { FAKE_ADB_DIE_ON_START: "1" });
			},
		});
		const first = await s.run("echo a");
		const second = await s.run("echo b");
		const third = await s.run("echo c");
		expect(!first.success && first.error.code).toBe("E_HELPER_CRASHED");
		expect(!second.success && second.error.code).toBe("E_HELPER_CRASHED");
		expect(!third.success && third.error.code).toBe("E_HELPER_CRASHED");
		expect(spawns).toBe(2);
	});

	test("a completed command resets the respawn budget", async () => {
		const s = open();
		for (let i = 0; i < 3; i++) {
			expect((await s.run("exit 1")).success).toBe(false);
			expect((await data(s.run("echo ok"))).stdout).toBe("ok\n");
		}
	});

	test("a missing adb binary is E_HELPER_MISSING", async () => {
		const s = openAdbSession({
			adb: "/nonexistent/adb",
			serial: "x",
			spawn: (argv) => spawnAdb(argv),
		});
		sessions.push(s);
		const r = await s.run("echo hi");
		expect(!r.success && r.error.code).toBe("E_HELPER_MISSING");
	});

	test("close kills the shell, fails later runs and is idempotent", async () => {
		const s = open();
		await data(s.run("echo warm"));
		await s.close();
		await s.close();
		const r = await s.run("echo again");
		expect(!r.success && r.error.code).toBe("E_INTERNAL");
	});

	test("close while a command is in flight settles it", async () => {
		const s = open();
		const pending = s.run("sleep 600000");
		await Bun.sleep(50);
		await s.close();
		const r = await pending;
		expect(r.success).toBe(false);
	});

	test("logs each command", async () => {
		const lines: string[] = [];
		const s = open({ log: (l) => lines.push(l) });
		await data(s.run("echo logged"));
		expect(lines.some((l) => l.includes("echo logged") && l.includes("-> 0"))).toBe(true);
	});
});
