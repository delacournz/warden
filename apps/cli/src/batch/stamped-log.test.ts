import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStampedLog } from "./stamped-log";

const AT = new Date(2026, 9, 15, 9, 5, 3, 7);
const T = "[09:05:03.007] ";

let dir = "";
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(c) {
			for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
			c.close();
		},
	});

describe("openStampedLog", () => {
	test("appends each stream's lines stamped, keeping what the file already had", async () => {
		dir = mkdtempSync(join(tmpdir(), "warden-stamped-"));
		const path = join(dir, "job.log");
		writeFileSync(path, "earlier\n");
		const log = openStampedLog(path, () => AT);
		await log.pump(streamOf("a\nb", "c\n"));
		await log.pump(streamOf("err\n"));
		log.close();
		expect(readFileSync(path, "utf8")).toBe(`earlier\n${T}a\n${T}bc\n${T}err\n`);
	});

	test("a multi-byte character split across chunks survives", async () => {
		dir = mkdtempSync(join(tmpdir(), "warden-stamped-"));
		const path = join(dir, "job.log");
		const bytes = new TextEncoder().encode(" ✓ ok\n");
		const log = openStampedLog(path, () => AT);
		await log.pump(
			new ReadableStream({
				start(c) {
					c.enqueue(bytes.slice(0, 2));
					c.enqueue(bytes.slice(2));
					c.close();
				},
			})
		);
		log.close();
		expect(readFileSync(path, "utf8")).toBe(`${T} ✓ ok\n`);
	});

	test("writes after close are dropped, not thrown", async () => {
		dir = mkdtempSync(join(tmpdir(), "warden-stamped-"));
		const path = join(dir, "job.log");
		const log = openStampedLog(path, () => AT);
		log.close();
		await log.pump(streamOf("late\n"));
		log.close();
		expect(readFileSync(path, "utf8")).toBe("");
	});

	test("a real child's stdout + stderr land stamped", async () => {
		dir = mkdtempSync(join(tmpdir(), "warden-stamped-"));
		const path = join(dir, "job.log");
		const log = openStampedLog(path, () => AT);
		const proc = Bun.spawn(["sh", "-c", "echo out; echo err >&2"], { stdout: "pipe", stderr: "pipe" });
		await Promise.all([log.pump(proc.stdout), log.pump(proc.stderr), proc.exited]);
		log.close();
		expect(readFileSync(path, "utf8").split("\n").sort()).toEqual(["", `${T}err`, `${T}out`]);
	});
});

/** a pipe a grandchild still holds: `push` writes to it, and it never ends */
function heldOpen() {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	return {
		stream,
		push: (text: string) => controller?.enqueue(new TextEncoder().encode(text)),
		end: () => controller?.close(),
	};
}

describe("StampedLog.drained", () => {
	const windowMs = { quietMs: 40, maxMs: 600 };

	test("is done at once when every stream has ended", async () => {
		dir = mkdtempSync(join(tmpdir(), "warden-stamped-"));
		const log = openStampedLog(join(dir, "job.log"), () => AT);
		const pumped = Promise.all([log.pump(streamOf("a\n")), log.pump(streamOf("b\n"))]);
		await pumped;
		const started = performance.now();
		await log.drained(windowMs);
		expect(performance.now() - started).toBeLessThan(windowMs.quietMs);
		log.close();
	});

	test("a stream a grandchild keeps open stops holding the exit once it has been silent for quietMs", async () => {
		dir = mkdtempSync(join(tmpdir(), "warden-stamped-"));
		const path = join(dir, "job.log");
		const log = openStampedLog(path, () => AT);
		const held = heldOpen();
		void log.pump(held.stream);
		held.push("last words\n");
		const started = performance.now();
		await log.drained(windowMs);
		const waited = performance.now() - started;
		expect(waited).toBeGreaterThanOrEqual(windowMs.quietMs - 5);
		expect(waited).toBeLessThan(windowMs.maxMs / 2);
		log.close();
		expect(readFileSync(path, "utf8")).toBe(`${T}last words\n`);
		held.end();
	});

	test("settles the moment the last stream ends, without a polling timer, and says how long it waited (13-6)", async () => {
		dir = mkdtempSync(join(tmpdir(), "warden-stamped-"));
		const log = openStampedLog(join(dir, "job.log"), () => AT);
		const held = heldOpen();
		void log.pump(held.stream);
		void log.pump(streamOf("done\n"));
		const drained = log.drained({ quietMs: 1000, maxMs: 2000 });
		await Bun.sleep(30);
		held.end();
		// the end of the pipe settles it within microtasks: before any timer (a 10 ms poll would lose this race)
		const first = await Promise.race([drained.then(() => "drained"), Bun.sleep(1).then(() => "timer")]);
		expect(first).toBe("drained");
		const waited = await drained;
		expect(waited).toBeGreaterThanOrEqual(25);
		expect(waited).toBeLessThan(500);
		log.close();
	});

	test("reports 0 when nothing was left to drain, and the quiet window it sat out for a held pipe", async () => {
		dir = mkdtempSync(join(tmpdir(), "warden-stamped-"));
		const log = openStampedLog(join(dir, "job.log"), () => AT);
		await log.pump(streamOf("a\n"));
		expect(await log.drained(windowMs)).toBe(0);
		const held = heldOpen();
		void log.pump(held.stream);
		const waited = await log.drained(windowMs);
		expect(waited).toBeGreaterThanOrEqual(windowMs.quietMs - 5);
		expect(waited).toBeLessThan(windowMs.maxMs / 2);
		log.close();
		held.end();
	});

	test("output still arriving keeps the wait going, up to maxMs", async () => {
		dir = mkdtempSync(join(tmpdir(), "warden-stamped-"));
		const log = openStampedLog(join(dir, "job.log"), () => AT);
		const held = heldOpen();
		void log.pump(held.stream);
		const chatter = setInterval(() => held.push("x\n"), 10);
		const started = performance.now();
		await log.drained({ quietMs: 40, maxMs: 200 });
		const waited = performance.now() - started;
		clearInterval(chatter);
		expect(waited).toBeGreaterThanOrEqual(195);
		expect(waited).toBeLessThan(400);
		log.close();
		held.end();
	});
});
