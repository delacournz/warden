import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFactsCache } from "@delacour/warden-runtime/git-facts";
import { fakeExec } from "@delacour/warden-runtime/testing/exec.testing";
import { openStore, type Store } from "@delacour/warden-store/store";
import type { Owner } from "@delacour/warden-store/types";
import type { WardenLogEvent } from "@delacour/warden-types/host";
import { type AppHost, fingerprint, loadProject, pickDevice, prepareApp, projectStart } from "./prepare";

let dir: string | undefined;
let store: Store | undefined;
afterEach(() => {
	store?.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
	store = undefined;
});

const HASH = "abc123def456";
const owner: Owner = { kind: "agent", sessionId: "me", cwd: "/" };

/** A host over a temp dir holding a one-project warden.config.json whose fingerprint command prints HASH. */
function setup(): { host: AppHost; events: WardenLogEvent[]; cwd: string } {
	dir = mkdtempSync(join(tmpdir(), "warden-prepare-"));
	store = openStore(join(dir, "warden.db"));
	const db = store;
	mkdirSync(join(dir, "app"), { recursive: true });
	writeFileSync(
		join(dir, "warden.config.json"),
		JSON.stringify({
			projects: [
				{
					name: "demo",
					root: "app",
					bundleId: { ios: "com.demo", android: "com.demo" },
					fingerprint: { command: "fp {platform}" },
				},
			],
		})
	);
	const events: WardenLogEvent[] = [];
	const host: AppHost = {
		env: { WARDEN_HOME: dir, HOME: dir },
		cwd: dir,
		home: dir,
		now: () => 1_000_000,
		exec: fakeExec([
			["sh -c fp ios", { stdout: JSON.stringify({ hash: HASH }) }],
			["git", { exitCode: 128 }],
		]),
		sleep: async () => {},
		pidAlive: () => false,
		log: (event) => events.push(event),
		store: () => db,
		git: createGitFactsCache(),
	};
	return { host, events, cwd: dir };
}

describe("projectStart", () => {
	test("no project is the cwd; a directory is resolved against it; a missing one is an error", () => {
		const { host, cwd } = setup();
		expect(projectStart(host, undefined)).toEqual({ success: true, data: cwd });
		expect(projectStart(host, "app")).toEqual({ success: true, data: join(cwd, "app") });
		const missing = projectStart(host, "nope");
		expect(!missing.success && missing.error).toContain("no such directory");
	});
});

describe("prepareApp", () => {
	test("loads the project, fingerprints it and announces the key as a fingerprint event", async () => {
		const { host, events } = setup();
		const prepared = await prepareApp(host, { eas: false, build: false }, "ios");
		expect(prepared.success && prepared.data.hash?.key).toBe(HASH);
		expect(events).toEqual([
			expect.objectContaining({ kind: "fingerprint", platform: "ios", key: HASH, project: "demo" }),
		]);
	});

	test("a project the options cannot find is an error, nothing announced", async () => {
		const { host, events } = setup();
		const prepared = await prepareApp(host, { project: "missing", eas: false, build: false }, "ios");
		expect(prepared.success).toBe(false);
		expect(events).toEqual([]);
	});
});

describe("fingerprint", () => {
	test("the event names the project key so a hash that differs from EAS's can be traced", async () => {
		const { host, events } = setup();
		const project = await loadProject(host, {}, "ios");
		if (!project.success) throw new Error(project.error);
		const hash = await fingerprint(host, project.data, "ios");
		expect(hash.success).toBe(true);
		expect(events[0]).toMatchObject({ kind: "fingerprint", projectKey: project.data.projectKey });
	});
});

describe("pickDevice", () => {
	const lease = (db: Store, platform: "ios" | "android", id: string) =>
		db.insertLease({ resource: { kind: "device", platform, id, name: id }, owner, ttlMs: 60_000 }, 0);

	test("--no-install picks nothing; --udid wins; --lease must be the platform's device", () => {
		const { host } = setup();
		const db = host.store();
		const l = lease(db, "ios", "U1");
		expect(pickDevice(host, owner, "ios", { noInstall: true })).toEqual({ success: true, data: undefined });
		expect(pickDevice(host, owner, "ios", { noInstall: false, udid: "X" })).toEqual({ success: true, data: "X" });
		expect(pickDevice(host, owner, "ios", { noInstall: false, lease: l.id })).toEqual({ success: true, data: "U1" });
		expect(pickDevice(host, owner, "android", { noInstall: false, lease: l.id }).success).toBe(false);
	});

	test("without flags: the caller's single device of the platform, else a message saying what to pass", () => {
		const { host } = setup();
		const db = host.store();
		const none = pickDevice(host, owner, "ios", { noInstall: false });
		expect(!none.success && none.error.message).toContain("you hold no ios device lease");
		lease(db, "ios", "U1");
		expect(pickDevice(host, owner, "ios", { noInstall: false })).toEqual({ success: true, data: "U1" });
		lease(db, "ios", "U2");
		const several = pickDevice(host, owner, "ios", { noInstall: false });
		expect(!several.success && several.error.message).toContain("you hold several ios devices");
	});
});
