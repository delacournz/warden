import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Collector, parseCollectorArgv, runCollector, startCollector } from "./collector";
import { fakePage, fakeTarget, page, startFakeMetro } from "./devtools.testing";

const cleanup: (() => void)[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) fn();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const str = (value: string) => ({ type: "string", value });

async function outDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "warden-collector-"));
	dirs.push(dir);
	return dir;
}

async function rows(path: string): Promise<Record<string, unknown>[]> {
	const text = await readFile(path, "utf8");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/** Sleeps only end when the test says time has passed, so idle exits take no real time. */
function fakeClock() {
	let now = 0;
	const waiting: { at: number; resolve: () => void }[] = [];
	return {
		sleep: (ms: number) =>
			new Promise<void>((resolve) => {
				waiting.push({ at: now + ms, resolve });
			}),
		async advance(ms: number) {
			const target = now + ms;
			for (;;) {
				const due = waiting.filter((w) => w.at <= target).sort((a, b) => a.at - b.at)[0];
				if (!due) break;
				now = due.at;
				waiting.splice(waiting.indexOf(due), 1);
				due.resolve();
				await Bun.sleep(15);
			}
			now = target;
		},
	};
}

/** Moves the fake clock in steps until `until` settles, however long the real I/O in between takes. */
async function runClock(clock: ReturnType<typeof fakeClock>, until: Promise<unknown>, stepMs = 250): Promise<void> {
	let settled = false;
	void until.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		}
	);
	for (let step = 0; step < 1000 && !settled; step++) {
		await clock.advance(stepMs);
		await Bun.sleep(5);
	}
}

async function start(extra: { idleMs?: number; signal?: AbortSignal } = {}) {
	const p = fakePage();
	const fake = startFakeMetro({ respond: p.respond });
	cleanup.push(() => void fake.stop());
	const out = await outDir();
	const clock = fakeClock();
	const started = await startCollector({
		metroUrl: fake.url,
		device: {},
		out,
		idleMs: extra.idleMs ?? 10_000,
		fetch,
		WebSocket,
		sleep: clock.sleep,
		signal: extra.signal,
	});
	if (!started.success) throw new Error(started.error.message);
	const collector: Collector = started.data;
	cleanup.push(() => collector.stop());
	return { ...p, fake, out, clock, collector };
}

describe("startCollector", () => {
	test("appends console lines and network entries to the two files as they arrive", async () => {
		const { fake, out, state, clock } = await start();
		fake.emit("Runtime.consoleAPICalled", { type: "warning", args: [str("careful")], timestamp: 5 });
		state.queue.push(page("https://api.test/a"));
		await clock.advance(500);
		const networkPath = join(out, "network.jsonl");
		for (let i = 0; i < 100 && (await rows(networkPath)).length === 0; i++) await Bun.sleep(20);
		expect((await rows(join(out, "console.jsonl"))).map((r) => [r.level, r.text])).toEqual([["warn", "careful"]]);
		expect((await rows(networkPath)).map((r) => r.url)).toEqual(["https://api.test/a"]);
	});

	test("creates both files up front", async () => {
		const { out } = await start();
		expect(await readFile(join(out, "console.jsonl"), "utf8")).toBe("");
		expect(await readFile(join(out, "network.jsonl"), "utf8")).toBe("");
	});

	test("exits as idle once a whole idle window passes without activity, and closes the socket", async () => {
		const { collector, clock, fake } = await start({ idleMs: 10_000 });
		await clock.advance(10_000);
		expect(await collector.done).toEqual({ reason: "idle" });
		await Bun.sleep(30);
		expect(fake.connections).toHaveLength(0);
	});

	test("activity keeps it alive for another window", async () => {
		const { collector, clock, fake } = await start({ idleMs: 10_000 });
		await clock.advance(5_000);
		fake.emit("Runtime.consoleAPICalled", { type: "log", args: [str("still here")], timestamp: 1 });
		await Bun.sleep(30);
		let ended = false;
		void collector.done.then(() => {
			ended = true;
		});
		await clock.advance(5_000);
		expect(ended).toBe(false);
		await clock.advance(10_000);
		expect(await collector.done).toEqual({ reason: "idle" });
	});

	test("an abort signal (SIGTERM) ends it after flushing", async () => {
		const controller = new AbortController();
		const { collector, fake, out } = await start({ signal: controller.signal });
		fake.emit("Runtime.consoleAPICalled", { type: "log", args: [str("last words")], timestamp: 1 });
		await Bun.sleep(30);
		controller.abort();
		expect(await collector.done).toEqual({ reason: "aborted" });
		expect((await rows(join(out, "console.jsonl"))).map((r) => r.text)).toEqual(["last words"]);
	});

	test("losing the app for good ends it as lost", async () => {
		const { collector, fake, clock } = await start({ idleMs: 1_000_000_000 });
		fake.setTargets([]);
		fake.dropAll();
		await runClock(clock, collector.done, 200);
		expect(await collector.done).toEqual({ reason: "lost" });
	});

	test("stop() is idempotent", async () => {
		const { collector } = await start();
		collector.stop();
		collector.stop();
		expect(await collector.done).toEqual({ reason: "aborted" });
	});

	test("a release build (no Metro) is devtools_unavailable", async () => {
		const down = startFakeMetro({ targets: [fakeTarget(1, 1)] });
		const url = down.url;
		await down.stop();
		const started = await startCollector({
			metroUrl: url,
			device: {},
			out: await outDir(),
			idleMs: 1000,
			fetch,
			WebSocket,
		});
		expect(!started.success && started.error.code).toBe("devtools_unavailable");
	});
});

describe("parseCollectorArgv", () => {
	test("reads the flags the CLI passes", () => {
		expect(
			parseCollectorArgv([
				"--metro",
				"http://127.0.0.1:8081",
				"--out",
				"/tmp/x",
				"--idle-ms",
				"5000",
				"--device-name",
				"iPhone A",
				"--logical-device-id",
				"L1",
				"--app-id",
				"com.a",
				"--include-bodies",
			])
		).toEqual({
			success: true,
			data: {
				metroUrl: "http://127.0.0.1:8081",
				out: "/tmp/x",
				idleMs: 5000,
				device: { deviceName: "iPhone A", logicalDeviceId: "L1", appId: "com.a" },
				includeBodies: true,
			},
		});
	});

	test("idle defaults to 60 s; --metro and --out are required; junk is rejected", () => {
		const minimal = parseCollectorArgv(["--metro", "http://m:1", "--out", "o"]);
		expect(minimal.success && minimal.data.idleMs).toBe(60_000);
		expect(parseCollectorArgv(["--out", "o"]).success).toBe(false);
		expect(parseCollectorArgv(["--metro", "http://m:1"]).success).toBe(false);
		expect(parseCollectorArgv(["--metro", "http://m:1", "--out", "o", "--idle-ms", "soon"]).success).toBe(false);
		expect(parseCollectorArgv(["--metro", "http://m:1", "--out", "o", "--nope"]).success).toBe(false);
		expect(parseCollectorArgv(["--metro"]).success).toBe(false);
	});
});

describe("runCollector", () => {
	test("exit 1 on bad usage, with the reason logged", async () => {
		const lines: string[] = [];
		const code = await runCollector(["--out", "o"], { fetch, log: (l) => lines.push(l) });
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("--metro");
	});

	test("exit 3 when there is no dev client to talk to", async () => {
		const down = startFakeMetro();
		const url = down.url;
		await down.stop();
		const code = await runCollector(["--metro", url, "--out", await outDir()], { fetch, WebSocket });
		expect(code).toBe(3);
	});

	test("exit 0 after idle, files written", async () => {
		const p = fakePage();
		const fake = startFakeMetro({ respond: p.respond });
		cleanup.push(() => void fake.stop());
		const out = await outDir();
		const clock = fakeClock();
		const running = runCollector(["--metro", fake.url, "--out", out, "--idle-ms", "1000"], {
			fetch,
			WebSocket,
			sleep: clock.sleep,
		});
		await runClock(clock, running);
		expect(await running).toBe(0);
		expect(await readFile(join(out, "console.jsonl"), "utf8")).toBe("");
	});
});
