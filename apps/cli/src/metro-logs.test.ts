import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDevSession } from "./dev-session";
import type { MetroLogEntry } from "./dev-tui/metro-log";
import { BUNDLE_OK, BUNDLE_SYNTAX_ERROR, RUNTIME_LOGS } from "./dev-tui/metro-log.testing";
import { filterMetroLogs, followMetroLog, parseMetroLogKinds, readMetroLogs } from "./metro-logs";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const alive = { isAlive: () => true };

/** A temp WARDEN_HOME with one dev session whose metro.log holds `log` (omitted: no file). */
function session(log?: string, leaseId = "L1") {
	const home = mkdtempSync(join(tmpdir(), "warden-metro-logs-"));
	homes.push(home);
	const env = { WARDEN_HOME: home };
	const logDir = join(home, "dev", leaseId);
	mkdirSync(logDir, { recursive: true });
	if (log !== undefined) writeFileSync(join(logDir, "metro.log"), log);
	writeDevSession(env, {
		version: 1,
		leaseId,
		pid: 1,
		platform: "ios",
		deviceId: `UDID-${leaseId}`,
		port: 8101,
		metroUrl: "http://localhost:8101",
		logDir,
		projectRoot: "/work/example",
		startedAt: "2026-10-27T00:00:00.000Z",
	});
	return { env, logDir };
}

describe("readMetroLogs", () => {
	test("returns the classified log of the only session", () => {
		const { env } = session(BUNDLE_OK + BUNDLE_SYNTAX_ERROR);
		const result = readMetroLogs(env, {}, alive);
		expect(result.success && result.data.map((e) => e.kind)).toEqual(["bundle_done", "bundle_done", "bundle_failed"]);
	});

	test("filters by kind, grep and tail", () => {
		const { env } = session(BUNDLE_OK + BUNDLE_SYNTAX_ERROR + RUNTIME_LOGS);
		const failed = readMetroLogs(env, { kinds: ["bundle_failed", "error"] }, alive);
		expect(failed.success && failed.data.map((e) => e.kind)).toEqual(["bundle_failed", "error"]);
		const grep = readMetroLogs(env, { grep: "unexpected token" }, alive);
		expect(grep.success && grep.data).toHaveLength(1);
		const tail = readMetroLogs(env, { tail: 2 }, alive);
		expect(tail.success && tail.data).toHaveLength(2);
	});

	test("an invalid grep is invalid_query", () => {
		const { env } = session(BUNDLE_OK);
		const result = readMetroLogs(env, { grep: "(" }, alive);
		expect(!result.success && result.error.code).toBe("invalid_query");
	});

	test("a log last written before --since is empty", () => {
		const { env, logDir } = session(BUNDLE_OK);
		utimesSync(join(logDir, "metro.log"), new Date(1_000_000), new Date(1_000_000));
		const result = readMetroLogs(env, { sinceMs: 2_000_000 }, alive);
		expect(result).toEqual({ success: true, data: [] });
	});

	test("a missing metro.log is metro_log_unavailable with a hint", () => {
		const { env } = session();
		const result = readMetroLogs(env, {}, alive);
		expect(!result.success && result.error.code).toBe("metro_log_unavailable");
		expect(!result.success && result.error.hint).toContain("warden dev");
	});

	test("no session is no_dev_session; two sessions are ambiguous until --udid", () => {
		const none = readMetroLogs({ WARDEN_HOME: mkdtempSync(join(tmpdir(), "warden-metro-logs-")) }, {}, alive);
		expect(!none.success && none.error.code).toBe("no_dev_session");
		const a = session(BUNDLE_OK, "A");
		writeDevSession(a.env, {
			version: 1,
			leaseId: "B",
			pid: 2,
			platform: "android",
			deviceId: "emulator-5554",
			port: 8102,
			metroUrl: "http://localhost:8102",
			logDir: join(a.env.WARDEN_HOME ?? "", "dev", "B"),
			projectRoot: "/work/other",
			startedAt: "2026-10-27T00:01:00.000Z",
		});
		const ambiguous = readMetroLogs(a.env, {}, alive);
		expect(!ambiguous.success && ambiguous.error.code).toBe("ambiguous_dev_session");
		const picked = readMetroLogs(a.env, { udid: "UDID-A" }, alive);
		expect(picked.success).toBe(true);
	});
});

describe("filterMetroLogs", () => {
	const entries: MetroLogEntry[] = [
		{ kind: "info", text: "old", ts: 100 },
		{ kind: "info", text: "new", ts: 300 },
		{ kind: "warn", text: "untimed" },
	];

	test("sinceMs drops entries stamped earlier and keeps untimed ones", () => {
		const result = filterMetroLogs(entries, { sinceMs: 200 });
		expect(result.success && result.data.map((e) => e.text)).toEqual(["new", "untimed"]);
	});
});

describe("parseMetroLogKinds", () => {
	test("accepts a comma list and rejects unknown names", () => {
		expect(parseMetroLogKinds("error, warn")).toEqual({ success: true, data: ["error", "warn"] });
		const bad = parseMetroLogKinds("error,nope");
		expect(!bad.success && bad.error.code).toBe("invalid_query");
	});
});

describe("followMetroLog", () => {
	test("emits entries appended after it started, holding an error block until the log goes quiet", async () => {
		const { logDir } = session(BUNDLE_OK);
		const path = join(logDir, "metro.log");
		const controller = new AbortController();
		const batches: MetroLogEntry[][] = [];
		let tick = 0;
		const sleep = async () => {
			tick++;
			if (tick === 1) appendFileSync(path, BUNDLE_SYNTAX_ERROR);
			if (tick === 4) controller.abort();
		};
		const done = await followMetroLog(logDir, {}, { now: () => 5_000, sleep, signal: controller.signal }, (entries) =>
			batches.push(entries)
		);
		expect(done.success).toBe(true);
		expect(batches).toHaveLength(1);
		expect(batches[0]?.map((e) => e.kind)).toEqual(["bundle_failed"]);
		expect(batches[0]?.[0]?.ts).toBe(5_000);
	});

	test("a missing log is metro_log_unavailable", async () => {
		const { logDir } = session();
		const controller = new AbortController();
		const done = await followMetroLog(
			logDir,
			{},
			{ now: () => 0, sleep: async () => {}, signal: controller.signal },
			() => {}
		);
		expect(!done.success && done.error.code).toBe("metro_log_unavailable");
	});
});
