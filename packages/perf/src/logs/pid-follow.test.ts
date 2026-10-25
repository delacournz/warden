import { describe, expect, test } from "bun:test";
import { followPid, type LogStream } from "./pid-follow";

/** Drive `followPid` through `pids` (one per tick), then abort. */
async function run(pids: Array<number | undefined>, opts: { dieAfterStart?: boolean } = {}) {
	const ctl = new AbortController();
	const spawned: string[][] = [];
	const killed: string[][] = [];
	const seen: Array<number | undefined> = [];
	let tick = 0;
	await followPid({
		resolvePid: async () => pids[tick],
		argvFor: (pid) => ["logcat", "--pid", String(pid)],
		spawn: (argv, onLine) => {
			spawned.push(argv);
			onLine(`line from ${argv[2]}`);
			let end: (code: number) => void = () => {};
			const exited = new Promise<number>((resolve) => {
				end = resolve;
			});
			if (opts.dieAfterStart) end(1);
			const stream: LogStream = {
				kill: () => {
					killed.push(argv);
					end(0);
				},
				exited,
			};
			return stream;
		},
		sleep: async () => {
			await Promise.resolve();
			tick++;
			if (tick >= pids.length) ctl.abort();
		},
		onLine: () => {},
		onPid: (p) => seen.push(p),
		signal: ctl.signal,
	});
	return { spawned, killed, seen };
}

describe("followPid", () => {
	test("starts once while the pid holds", async () => {
		const r = await run([100, 100, 100]);
		expect(r.spawned).toEqual([["logcat", "--pid", "100"]]);
		expect(r.killed).toEqual([["logcat", "--pid", "100"]]);
	});

	test("restarts on a new pid, killing the old stream first", async () => {
		const r = await run([100, 100, 200, 200]);
		expect(r.spawned.map((a) => a[2])).toEqual(["100", "200"]);
		expect(r.killed.map((a) => a[2])).toEqual(["100", "200"]);
		expect(r.seen).toEqual([100, 200]);
	});

	test("waits while the app is not running, then follows it", async () => {
		const r = await run([undefined, undefined, 300, 300]);
		expect(r.spawned.map((a) => a[2])).toEqual(["300"]);
		expect(r.seen).toEqual([300]);
	});

	test("app gone stops the stream", async () => {
		const r = await run([100, undefined, undefined]);
		expect(r.killed.map((a) => a[2])).toEqual(["100"]);
		expect(r.seen).toEqual([100, undefined]);
	});

	test("restarts a stream that died on its own", async () => {
		const r = await run([100, 100, 100], { dieAfterStart: true });
		expect(r.spawned.length).toBeGreaterThan(1);
	});
});
