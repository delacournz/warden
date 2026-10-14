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
