import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store";
import { GOLDEN_RECIPE, goldenKey, goldenName, wipName } from "./golden";
import { fakeHost, IPHONE_17, RUNTIME_BUILD, RUNTIME_ID } from "./golden.testing";
import type { GoldenDeps } from "./ios-golden";
import { ensureGolden } from "./ios-golden";
import { exportGolden, GOLDEN_MANIFEST, goldenInfo, importGoldens } from "./ios-golden-archive";

let dir: string;
let home: string;
let archive: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-golden-archive-"));
	home = join(dir, "home");
	archive = join(dir, "archive");
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const INPUTS = { xcodeBuild: "17F113", runtimeId: RUNTIME_ID, runtimeBuild: RUNTIME_BUILD, deviceType: IPHONE_17 };
const KEY = goldenKey(INPUTS);
const GOLDEN = goldenName("iphone-17", KEY);

function deps(host: ReturnType<typeof fakeHost>, logs: string[] = []): GoldenDeps {
	let clock = 0;
	return {
		exec: host.exec,
		store,
		owner: { kind: "agent", sessionId: "s", cwd: "/" },
		pid: process.pid,
		env: { HOME: home },
		now: () => clock,
		pidAlive: () => true,
		sleep: async (ms) => {
			clock += ms;
		},
		log: (line) => logs.push(line),
	};
}

const deviceDir = (udid: string) => join(home, "Library/Developer/CoreSimulator/Devices", udid);

/** A first-booted device on disk: `device.plist`, `data/` with a pref and an absolute symlink into its own dir. */
function seedDevice(udid: string): void {
	const root = deviceDir(udid);
	mkdirSync(join(root, "data/Library/Preferences"), { recursive: true });
	writeFileSync(join(root, "device.plist"), `<plist>${udid}</plist>`);
	writeFileSync(join(root, "data/Library/Preferences/com.apple.migration.plist"), "migrated");
	mkdirSync(join(root, "data/Library/Trial"), { recursive: true });
	symlinkSync(join(root, "data/Library/Preferences"), join(root, "data/Library/Trial/prefs"));
	symlinkSync("relative-target", join(root, "data/Library/Trial/rel"));
	mkdirSync(join(root, "datacom.apple.modelcatalog/tokenStore"), { recursive: true });
}

function writeManifest(name: string, overrides: Record<string, unknown> = {}): void {
	const root = join(archive, name);
	mkdirSync(join(root, "device/data/Library/Preferences"), { recursive: true });
	writeFileSync(join(root, "device/data/Library/Preferences/com.apple.migration.plist"), "migrated");
	mkdirSync(join(root, "device/data/Library/Trial"), { recursive: true });
	symlinkSync(join(deviceDir("OLD-UDID"), "data/Library/Preferences"), join(root, "device/data/Library/Trial/prefs"));
	writeFileSync(
		join(root, GOLDEN_MANIFEST),
		JSON.stringify({
			version: 1,
			name,
			key: KEY,
			recipe: GOLDEN_RECIPE,
			profile: "iphone-17",
			udid: "OLD-UDID",
			...INPUTS,
			exportedAt: 0,
			...overrides,
		})
	);
}

describe("goldenInfo", () => {
	test("the key, name and inputs of this machine's golden, without building it", async () => {
		const host = fakeHost();
		const info = await goldenInfo(deps(host), "iphone-17");
		expect(info).toEqual({
			success: true,
			data: { profile: "iphone-17", key: KEY, name: GOLDEN, recipe: GOLDEN_RECIPE, ...INPUTS },
		});
		expect(host.calls.some((c) => c[2] === "create")).toBe(false);
	});
});

describe("exportGolden", () => {
	test("copies the golden's device dir (not device.plist) and a manifest; symlinks verbatim", async () => {
		const host = fakeHost({ sims: [{ udid: "G", name: GOLDEN, state: "Shutdown" }], migrationPolls: 0 });
		seedDevice("G");
		const result = await exportGolden(deps(host), "iphone-17", undefined, archive);
		expect(result.success).toBe(true);
		if (!result.success) return;
		const out = join(archive, GOLDEN);
		expect(result.data).toMatchObject({ name: GOLDEN, key: KEY, built: false, path: out });
		expect(readFileSync(join(out, "device/data/Library/Preferences/com.apple.migration.plist"), "utf8")).toBe(
			"migrated"
		);
		expect(existsSync(join(out, "device/datacom.apple.modelcatalog/tokenStore"))).toBe(true);
		expect(existsSync(join(out, "device/device.plist"))).toBe(false);
		expect(readlinkSync(join(out, "device/data/Library/Trial/prefs"))).toBe(
			join(deviceDir("G"), "data/Library/Preferences")
		);
		expect(JSON.parse(readFileSync(join(out, GOLDEN_MANIFEST), "utf8"))).toMatchObject({
			version: 1,
			name: GOLDEN,
			key: KEY,
			recipe: GOLDEN_RECIPE,
			profile: "iphone-17",
			udid: "G",
			...INPUTS,
		});
		expect(store.listLeases()).toEqual([]);
	});

	test("no golden yet → builds it, then exports; a second export replaces the first", async () => {
		const host = fakeHost({ migrationPolls: 0 });
		const d = deps(host);
		seedDevice("NEW-1");
		const first = await exportGolden(d, "iphone-17", undefined, archive);
		expect(first.success && first.data.built).toBe(true);
		writeFileSync(join(archive, GOLDEN, "device/stale"), "x");
		const again = await exportGolden(d, "iphone-17", undefined, archive);
		expect(again.success && again.data.built).toBe(false);
		expect(existsSync(join(archive, GOLDEN, "device/stale"))).toBe(false);
	});

	test("a golden this export just built that never settled → not exported, kept on the machine", async () => {
		const logs: string[] = [];
		const host = fakeHost({ migrationPolls: 0, cpu: [300] });
		seedDevice("NEW-1");
		const result = await exportGolden(deps(host, logs), "iphone-17", undefined, archive);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error).toContain("did not settle");
		expect(existsSync(join(archive, GOLDEN))).toBe(false);
		expect(host.sims).toEqual([{ udid: "NEW-1", name: GOLDEN, state: "Shutdown" }]);
		expect(store.listLeases()).toEqual([]);
	});

	test("an unsettled golden a claim built earlier → a later export (another process) still refuses it", async () => {
		const host = fakeHost({ migrationPolls: 0, cpu: [300] });
		seedDevice("NEW-1");
		const claimed = await ensureGolden(deps(host), "iphone-17");
		expect(claimed.success && claimed.data).toMatchObject({ built: true, unsettled: true });
		const reused = await ensureGolden(deps(host), "iphone-17");
		expect(reused.success && reused.data).toMatchObject({ built: false, unsettled: true });
		const exported = await exportGolden(deps(host), "iphone-17", undefined, archive);
		expect(exported.success).toBe(false);
		expect(existsSync(join(archive, GOLDEN))).toBe(false);
	});

	test("a settled golden reused later → no unsettled mark, exported", async () => {
		const host = fakeHost({ migrationPolls: 0 });
		seedDevice("NEW-1");
		await ensureGolden(deps(host), "iphone-17");
		const exported = await exportGolden(deps(host), "iphone-17", undefined, archive);
		expect(exported.success).toBe(true);
		expect(existsSync(join(archive, GOLDEN, "device", "warden-golden-unsettled"))).toBe(false);
	});
});

describe("importGoldens", () => {
	test("registers a new device, swaps in the archived data, re-points its own symlinks, promotes it", async () => {
		writeManifest(GOLDEN);
		const host = fakeHost({ migrationPolls: 0 });
		const result = await importGoldens(deps(host), archive);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual([{ name: GOLDEN, profile: "iphone-17", imported: true, udid: "NEW-1" }]);
		expect(host.sims).toEqual([{ udid: "NEW-1", name: GOLDEN, state: "Shutdown" }]);
		const created = host.calls.find((c) => c[2] === "create");
		expect(created).toEqual(["xcrun", "simctl", "create", wipName("iphone-17", KEY), IPHONE_17, RUNTIME_ID]);
		expect(readFileSync(join(deviceDir("NEW-1"), "data/Library/Preferences/com.apple.migration.plist"), "utf8")).toBe(
			"migrated"
		);
		expect(readlinkSync(join(deviceDir("NEW-1"), "data/Library/Trial/prefs"))).toBe(
			join(deviceDir("NEW-1"), "data/Library/Preferences")
		);
		// the imported golden is the one a claim clones from: no build
		const ensured = await ensureGolden(deps(host), "iphone-17");
		expect(ensured).toEqual({ success: true, data: { udid: "NEW-1", name: GOLDEN, built: false } });
		expect(store.listLeases()).toEqual([]);
	});

	test("a golden already on the machine → left alone", async () => {
		writeManifest(GOLDEN);
		const host = fakeHost({ sims: [{ udid: "G", name: GOLDEN, state: "Shutdown" }], migrationPolls: 0 });
		const result = await importGoldens(deps(host), archive);
		expect(result.success && result.data).toEqual([
			{ name: GOLDEN, profile: "iphone-17", imported: false, udid: "G", reason: "already on this machine" },
		]);
		expect(host.calls.some((c) => c[2] === "create")).toBe(false);
	});

	test("an archive for another Xcode / runtime / recipe → skipped with the reason, nothing created", async () => {
		const other = goldenName("iphone-17", "0123456789");
		writeManifest(other, { key: "0123456789", xcodeBuild: "16A000" });
		const host = fakeHost({ migrationPolls: 0 });
		const result = await importGoldens(deps(host), archive);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toHaveLength(1);
		expect(result.data[0]).toMatchObject({ name: other, imported: false });
		expect(JSON.stringify(result.data[0])).toContain(`this machine's golden is ${GOLDEN}`);
		expect(host.sims).toEqual([]);
	});

	test("the copied data has no finished migration → the new device is deleted, skipped", async () => {
		writeManifest(GOLDEN);
		const host = fakeHost({ migrationPolls: Number.POSITIVE_INFINITY });
		const result = await importGoldens(deps(host), archive);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data[0]).toMatchObject({ name: GOLDEN, imported: false });
		expect(JSON.stringify(result.data[0])).toContain("migration");
		expect(host.sims).toEqual([]);
		expect(existsSync(deviceDir("NEW-1"))).toBe(false);
	});

	test("the copied data has no AutomationEnabled → the new device is deleted, skipped", async () => {
		writeManifest(GOLDEN);
		const host = fakeHost({ migrationPolls: 0, automationMissing: "all" });
		const result = await importGoldens(deps(host), archive);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data[0]).toMatchObject({ name: GOLDEN, imported: false });
		expect(JSON.stringify(result.data[0])).toContain("AutomationEnabled");
		expect(host.sims).toEqual([]);
		expect(existsSync(deviceDir("NEW-1"))).toBe(false);
	});

	test("a manifest that does not parse → skipped, not an error", async () => {
		mkdirSync(join(archive, "junk"), { recursive: true });
		writeFileSync(join(archive, "junk", GOLDEN_MANIFEST), "{");
		const result = await importGoldens(deps(fakeHost()), archive);
		expect(result.success && result.data).toEqual([
			{ name: "junk", imported: false, reason: `unreadable ${GOLDEN_MANIFEST}` },
		]);
	});

	test("no archive dir (a cache miss) → nothing to import", async () => {
		const result = await importGoldens(deps(fakeHost()), join(dir, "missing"));
		expect(result).toEqual({ success: true, data: [] });
	});
});
