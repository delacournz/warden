import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPhaseLog, timed } from "./phases";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("timed", () => {
	test("returns result and elapsed from the injected clock", async () => {
		const ticks = [100, 350];
		const r = await timed("x", async () => "v", { now: () => ticks.shift() ?? 0 });
		expect(r).toEqual({ result: "v", ms: 250 });
	});
});

describe("openPhaseLog", () => {
	test("appends timestamped lines under logs/ and stops after close", () => {
		const dir = mkdtempSync(join(tmpdir(), "phase-"));
		dirs.push(dir);
		const log = openPhaseLog(dir, "prepare", () => new Date("2026-01-01T00:00:00.000Z"));
		log.line("a");
		log.line("b");
		log.close();
		log.line("c");
		expect(log.path).toBe(join(dir, "logs", "prepare.log"));
		expect(readFileSync(log.path, "utf8")).toBe("2026-01-01T00:00:00.000Z a\n2026-01-01T00:00:00.000Z b\n");
	});
});
