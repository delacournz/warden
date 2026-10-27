import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DevSessionRecord,
	findDevSession,
	listDevSessions,
	removeDevSession,
	updateDevSession,
	writeDevSession,
} from "./dev-session";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempEnv(): Record<string, string | undefined> {
	const home = mkdtempSync(join(tmpdir(), "warden-dev-session-"));
	homes.push(home);
	return { WARDEN_HOME: home };
}

function record(overrides: Partial<DevSessionRecord> = {}): DevSessionRecord {
	return {
		version: 1,
		leaseId: "lease-a",
		pid: 100,
		platform: "ios",
		deviceId: "UDID-A",
		port: 8101,
		metroUrl: "http://localhost:8101",
		logDir: "/logs/a",
		projectRoot: "/work/example",
		startedAt: "2026-10-27T00:00:00.000Z",
		...overrides,
	};
}

const alive = { isAlive: (pid: number) => pid !== 999 };

describe("dev session registry", () => {
	test("write then list round-trips a record", () => {
		const env = tempEnv();
		expect(writeDevSession(env, record()).success).toBe(true);
		const listed = listDevSessions(env, alive);
		expect(listed).toEqual({ success: true, data: [record()] });
	});

	test("writes under dev/<leaseId>/session.json", async () => {
		const env = tempEnv();
		const written = writeDevSession(env, record({ leaseId: "L1" }));
		expect(written.success && written.data).toBe(join(env.WARDEN_HOME ?? "", "dev", "L1", "session.json"));
	});

	test("remove deletes the record and tolerates a missing one", () => {
		const env = tempEnv();
		writeDevSession(env, record());
		removeDevSession(env, "lease-a");
		removeDevSession(env, "lease-a");
		expect(listDevSessions(env, alive)).toEqual({ success: true, data: [] });
	});

	test("a dead pid is ignored", () => {
		const env = tempEnv();
		writeDevSession(env, record({ leaseId: "dead", pid: 999 }));
		writeDevSession(env, record({ leaseId: "live", pid: 100 }));
		const listed = listDevSessions(env, alive);
		expect(listed.success && listed.data.map((s) => s.leaseId)).toEqual(["live"]);
	});

	test("an unreadable or invalid record is ignored", () => {
		const env = tempEnv();
		const dir = join(env.WARDEN_HOME ?? "", "dev", "junk");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "session.json"), "{not json");
		const bad = join(env.WARDEN_HOME ?? "", "dev", "wrong");
		mkdirSync(bad, { recursive: true });
		writeFileSync(join(bad, "session.json"), JSON.stringify({ version: 2, pid: "x" }));
		writeDevSession(env, record());
		const listed = listDevSessions(env, alive);
		expect(listed.success && listed.data.map((s) => s.leaseId)).toEqual(["lease-a"]);
	});

	test("update merges a patch", () => {
		const env = tempEnv();
		writeDevSession(env, record());
		const updated = updateDevSession(env, "lease-a", { brokerSocket: "/logs/a/broker.sock" });
		expect(updated.success && updated.data.brokerSocket).toBe("/logs/a/broker.sock");
		const listed = listDevSessions(env, alive);
		expect(listed.success && listed.data[0]?.brokerSocket).toBe("/logs/a/broker.sock");
	});

	test("update of a missing session is no_dev_session", () => {
		const updated = updateDevSession(tempEnv(), "nope", { brokerSocket: "x" });
		expect(!updated.success && updated.error.code).toBe("no_dev_session");
	});

	test("find: no session is no_dev_session", () => {
		const found = findDevSession(tempEnv(), {}, alive);
		expect(!found.success && found.error.code).toBe("no_dev_session");
	});

	test("find: a single session matches without a filter", () => {
		const env = tempEnv();
		writeDevSession(env, record());
		const found = findDevSession(env, {}, alive);
		expect(found.success && found.data.leaseId).toBe("lease-a");
	});

	test("find: several sessions without a filter are ambiguous and listed", () => {
		const env = tempEnv();
		writeDevSession(env, record({ leaseId: "a", deviceId: "UDID-A" }));
		writeDevSession(env, record({ leaseId: "b", deviceId: "UDID-B", port: 8102 }));
		const found = findDevSession(env, {}, alive);
		expect(!found.success && found.error.code).toBe("ambiguous_dev_session");
		expect(!found.success && found.error.message).toContain("UDID-A");
		expect(!found.success && found.error.message).toContain("UDID-B");
	});

	test("find: filters by udid and by project root", () => {
		const env = tempEnv();
		writeDevSession(env, record({ leaseId: "a", deviceId: "UDID-A", projectRoot: "/p/one" }));
		writeDevSession(env, record({ leaseId: "b", deviceId: "UDID-B", projectRoot: "/p/two" }));
		const byUdid = findDevSession(env, { udid: "UDID-B" }, alive);
		expect(byUdid.success && byUdid.data.leaseId).toBe("b");
		const byProject = findDevSession(env, { projectRoot: "/p/one" }, alive);
		expect(byProject.success && byProject.data.leaseId).toBe("a");
		const none = findDevSession(env, { udid: "UDID-Z" }, alive);
		expect(!none.success && none.error.code).toBe("no_dev_session");
	});
});
