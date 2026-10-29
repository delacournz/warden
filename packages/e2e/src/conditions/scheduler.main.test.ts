import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConditionEvents } from "./condition-events";

/** The detached entry end to end: a real child process calling fake-adb, which logs each argv. */

const FAKE_ADB = join(import.meta.dir, "../../native/scripts/fake-adb.ts");
const MAIN = join(import.meta.dir, "scheduler.main.ts");

function fakeDevice(rules: unknown[]) {
	const dir = mkdtempSync(join(tmpdir(), "wdn-sched-"));
	const rulesPath = join(dir, "rules.json");
	writeFileSync(rulesPath, JSON.stringify({ rules }));
	const wrapper = join(dir, "adb.sh");
	const log = join(dir, "calls.log");
	writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> ${log}\nexec bun ${FAKE_ADB} "$@"\n`, { mode: 0o755 });
	const run = (config: object) =>
		Bun.spawn(["bun", MAIN, JSON.stringify({ platform: "android", id: "emulator-5554", adb: wrapper, ...config })], {
			env: { ...process.env, FAKE_ADB_RULES: rulesPath },
			stdout: "ignore",
			stderr: "pipe",
		});
	return { dir, log, run, calls: () => readFileSync(log, "utf8").trim().split("\n") };
}

describe("scheduler.main.ts", () => {
	test("a timeline plays location points via adb emu geo fix and writes condition events", async () => {
		const d = fakeDevice([{ match: "emu geo fix", stdout: "OK\n" }]);
		const events = join(d.dir, "results.jsonl");
		const proc = d.run({
			mode: "timeline",
			events,
			steps: [
				{ atMs: 0, location: { kind: "point", lat: 1, lon: 2 } },
				{ atMs: 80, location: { kind: "point", lat: 3, lon: 4 } },
			],
		});
		expect(await proc.exited).toBe(0);
		const geo = d.calls().filter((l) => l.includes("geo fix"));
		expect(geo).toEqual(["-s emulator-5554 emu geo fix 2 1", "-s emulator-5554 emu geo fix 4 3"]);
		const logged = readConditionEvents(readFileSync(events, "utf8"));
		expect(logged.map((e) => [e.area, e.value.kind])).toEqual([
			["location", "point"],
			["location", "point"],
		]);
	});

	test("a flap goes to base at once and SIGTERM stops it cleanly", async () => {
		const d = fakeDevice([
			{ match: "dumpsys connectivity", stdout: "Active default network: 101\n" },
			{ match: "cmd connectivity", stdout: "" },
			{ match: "emu network", stdout: "OK\n" },
		]);
		const events = join(d.dir, "results.jsonl");
		const proc = d.run({ mode: "flap", events, flap: { upMs: 60_000, downMs: 60_000 } });
		await Bun.sleep(1500);
		proc.kill("SIGTERM");
		expect(await proc.exited).toBe(0);
		const calls = d.calls();
		expect(calls.some((l) => l.includes("emu network speed full"))).toBe(true);
		expect(readConditionEvents(readFileSync(events, "utf8")).map((e) => e.value)).toEqual([{ kind: "online" }]);
	});

	test("a failing step sequence exits 1; bad config and ios (not wired) exit 2", async () => {
		const d = fakeDevice([{ match: "emu geo fix", stdout: "KO: no\n" }]);
		const failing = d.run({
			mode: "timeline",
			steps: [0, 1, 2].map((atMs) => ({ atMs, location: { kind: "point", lat: 0, lon: 0 } })),
		});
		expect(await failing.exited).toBe(1);
		const bad = Bun.spawn(["bun", MAIN, "{"], { stdout: "ignore", stderr: "ignore" });
		expect(await bad.exited).toBe(2);
		const ios = Bun.spawn(
			["bun", MAIN, JSON.stringify({ platform: "ios", id: "U", mode: "flap", flap: { upMs: 1, downMs: 1 } })],
			{ stdout: "ignore", stderr: "ignore" }
		);
		expect(await ios.exited).toBe(2);
	});
});
