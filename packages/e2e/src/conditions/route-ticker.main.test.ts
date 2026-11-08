import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The detached entry end to end: a real child process calling fake-adb, which logs each argv. */

const FAKE_ADB = join(import.meta.dir, "../../native/scripts/fake-adb.ts");
const MAIN = join(import.meta.dir, "route-ticker.main.ts");

describe("route-ticker.main.ts", () => {
	test("plays a route against adb emu geo fix (longitude first) and exits 0", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wdn-ticker-"));
		const rules = join(dir, "rules.json");
		writeFileSync(rules, JSON.stringify({ rules: [{ match: "emu geo fix", stdout: "OK\n" }] }));
		const wrapper = join(dir, "adb.sh");
		const log = join(dir, "calls.log");
		writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> ${log}\nexec bun ${FAKE_ADB} "$@"\n`, { mode: 0o755 });
		const config = {
			adb: wrapper,
			serial: "emulator-5554",
			points: [
				{ lat: 0, lon: 0 },
				{ lat: 0, lon: 0.0003 },
			],
			speedMps: 20,
			intervalS: 0.05,
		};
		const proc = Bun.spawn(["bun", MAIN, JSON.stringify(config)], {
			env: { ...process.env, FAKE_ADB_RULES: rules },
			stdout: "ignore",
			stderr: "pipe",
		});
		expect(await proc.exited).toBe(0);
		const lines = readFileSync(log, "utf8").trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines[0]).toBe("-s emulator-5554 emu geo fix 0 0");
		expect(lines.at(-1)).toBe("-s emulator-5554 emu geo fix 0.0003 0");
	});

	test("bad config exits 2 and SIGTERM stops a loop", async () => {
		const bad = Bun.spawn(["bun", MAIN, "{"], { stdout: "ignore", stderr: "ignore" });
		expect(await bad.exited).toBe(2);
		const dir = mkdtempSync(join(tmpdir(), "wdn-ticker-"));
		const config = {
			adb: FAKE_ADB,
			serial: "emulator-5554",
			points: [
				{ lat: 0, lon: 0 },
				{ lat: 0, lon: 0.01 },
			],
			loop: true,
		};
		writeFileSync(join(dir, "x"), "");
		const proc = Bun.spawn(["bun", MAIN, JSON.stringify(config)], { stdout: "ignore", stderr: "ignore" });
		await Bun.sleep(400);
		proc.kill("SIGTERM");
		expect(await proc.exited).toBe(0);
	});
});
