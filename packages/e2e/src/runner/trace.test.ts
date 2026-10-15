import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestResult } from "./results";
import { clockOf, formatConsoleLine, openTrace, readTrace, shortName, type TraceEvent } from "./trace";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TS = new Date(2026, 9, 15, 0, 54, 25, 766).getTime();
const FILE = "e2e/onboarding.e2e.ts";
const TITLE = "onboarding steps through to sign-in";

const result: TestResult = {
	file: FILE,
	title: [TITLE],
	status: "passed",
	durationMs: 6880,
	startedAt: TS,
	device: { udid: "4115EA7D-AAAA-BBBB-CCCC-DDDDEEEEFFFF", platform: "ios" },
};

describe("formatConsoleLine goldens", () => {
	const clock = { clock: true };
	const plain = { clock: false };

	test("test start / end with clock", () => {
		expect(formatConsoleLine({ type: "test-start", test: result }, clock)).toBe(
			"[00:54:25.766] ▶ test |ios| e2e/onboarding.e2e.ts › onboarding steps through to sign-in"
		);
		expect(formatConsoleLine({ type: "test-end", result }, clock)).toBe(
			"[00:54:32.646] ■ test |ios| e2e/onboarding.e2e.ts › onboarding steps through to sign-in passed 6.88s on 4115EA7D-…"
		);
	});

	test("no clock under WARDEN_LOG_TIMESTAMPS=1", () => {
		expect(formatConsoleLine({ type: "test-start", test: result }, plain)).toBe(
			"▶ test |ios| e2e/onboarding.e2e.ts › onboarding steps through to sign-in"
		);
	});

	test("nested titles join with ›, device name wins", () => {
		const line = formatConsoleLine(
			{
				type: "test-end",
				result: {
					...result,
					title: ["auth", "rejects bad password"],
					status: "failed",
					durationMs: 1234,
					device: { udid: "U", platform: "android", name: "Pixel_8" },
				},
			},
			plain
		);
		expect(line).toBe("■ test |android| e2e/onboarding.e2e.ts › auth › rejects bad password failed 1.23s on Pixel_8");
	});

	test("step lines", () => {
		const start: TraceEvent = { type: "step-start", ts: TS + 176, kind: "app", label: "app.open" };
		const end: TraceEvent = {
			type: "step-end",
			ts: TS + 1427,
			kind: "app",
			label: "app.open",
			status: "passed",
			ms: 1251,
		};
		const opts = { clock: true, short: "onboarding", depth: 0 };
		expect(formatConsoleLine(start, opts)).toBe("[00:54:25.942]   ▸ onboarding › app app.open");
		expect(formatConsoleLine(end, opts)).toBe("[00:54:27.193]   ▪ onboarding › app app.open passed 1251ms");
	});

	test("failed step carries the error; depth indents", () => {
		const end: TraceEvent = {
			type: "step-end",
			ts: TS,
			kind: "locator",
			label: "tap id=submit",
			status: "failed",
			ms: 30000,
			error: "TIMEOUT: no match",
		};
		expect(formatConsoleLine(end, { clock: false, short: "login", depth: 1 })).toBe(
			"    ▪ login › locator tap id=submit failed 30000ms — TIMEOUT: no match"
		);
	});

	test("screenshots and notes print nothing", () => {
		expect(formatConsoleLine({ type: "note", ts: TS, kind: "note", label: "x" }, plain)).toBeUndefined();
		expect(
			formatConsoleLine({ type: "screenshot", ts: TS, kind: "screenshot", label: "x", path: "/a.png" }, plain)
		).toBeUndefined();
	});
});

describe("helpers", () => {
	test("clockOf pads to HH:MM:SS.mmm", () => {
		expect(clockOf(new Date(2026, 0, 1, 3, 4, 5, 6).getTime())).toBe("03:04:05.006");
	});
	test("shortName", () => {
		expect(shortName("e2e/sign-in.e2e.ts")).toBe("sign-in");
		expect(shortName("/a/b/flow.test.tsx")).toBe("flow.test");
	});
});

describe("trace.jsonl", () => {
	test("writes events, mirrors them, reads back tolerating a cut line", () => {
		const dir = mkdtempSync(join(tmpdir(), "wdn-trace-"));
		dirs.push(dir);
		const path = join(dir, "a", "trace.jsonl");
		const mirrored: TraceEvent[] = [];
		const trace = openTrace(path, (e) => mirrored.push(e));
		const events: TraceEvent[] = [
			{ type: "step-start", ts: 1, kind: "app", label: "app.open" },
			{ type: "screenshot", ts: 2, kind: "screenshot", label: "home", path: "/s/001-home.png" },
			{ type: "step-end", ts: 3, kind: "app", label: "app.open", status: "failed", ms: 2, error: "boom" },
		];
		for (const e of events) trace.write(e);
		expect(mirrored).toEqual(events);
		const text = readFileSync(path, "utf8");
		expect(readTrace(text)).toEqual(events);
		expect(readTrace(`${text}{"type":"note","ts"`)).toEqual(events);
	});
});
