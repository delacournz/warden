import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { findOrphans, type OrphanDeps, removeOrphans } from "./orphans";

const NOW = Date.UTC(2026, 9, 28, 12);
const HOUR = 3_600_000;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "warden-orphans-"));
	dirs.push(d);
	return d;
}

/** Fake runner: first prefix that matches wins; anything else is exit 127. Every command is logged. */
function fakeExec(replies: Record<string, Partial<ExecResult>>, calls: string[][] = []): Exec {
	return async (cmd) => {
		calls.push([...cmd]);
		const key = Object.keys(replies).find((k) => cmd.join(" ").startsWith(k));
		if (key === undefined) return { exitCode: 127, stdout: "", stderr: "not found" };
		return { exitCode: 0, stdout: "", stderr: "", ...replies[key] };
	};
}

/** No xcodebuild running (pgrep exits 1), `du` reports 2 MiB. */
const IDLE = {
	"pgrep -fl xcodebuild": { exitCode: 1 },
	"pgrep -f xcodebuild|XCTestDevices": { exitCode: 1 },
	"du -sk": { stdout: "2048\tx\n" },
};

function plist(workspace: string): string {
	return `<?xml version="1.0"?><plist><dict><key>WorkspacePath</key>\n<string>${workspace}</string></dict></plist>`;
}

function derivedData(home: string, name: string, workspace: string | undefined): string {
	const dir = join(home, "Library", "Developer", "Xcode", "DerivedData", name);
	mkdirSync(dir, { recursive: true });
	if (workspace !== undefined) writeFileSync(join(dir, "info.plist"), plist(workspace));
	return dir;
}

function deps(home: string, exec: Exec = fakeExec(IDLE)): OrphanDeps {
	return { home, exec, now: NOW, platform: "darwin", uid: process.getuid?.() ?? 0 };
}

function xctestDevices(home: string, ageMs: number): string {
	const dir = join(home, "Library", "Developer", "XCTestDevices");
	mkdirSync(join(dir, "CLONE-1", "data"), { recursive: true });
	const file = join(dir, "CLONE-1", "data", "state");
	writeFileSync(file, "x");
	const t = (NOW - ageMs) / 1000;
	for (const p of [file, join(dir, "CLONE-1", "data"), join(dir, "CLONE-1"), dir]) utimesSync(p, t, t);
	return dir;
}

describe("findOrphans DerivedData", () => {
	test("orphan: workspace recorded and gone", async () => {
		const home = tmp();
		const gone = join(home, "work", "deleted-tree", "App.xcworkspace");
		const dir = derivedData(home, "App-abc", gone);
		expect(await findOrphans(deps(home))).toEqual([
			{ kind: "derived-data", path: dir, workspace: gone, bytes: 2048 * 1024 },
		]);
	});

	test("live: workspace still exists", async () => {
		const home = tmp();
		const ws = join(home, "work", "App.xcworkspace");
		mkdirSync(ws, { recursive: true });
		derivedData(home, "App-live", ws);
		expect(await findOrphans(deps(home))).toEqual([]);
	});

	test("no info.plist and no WorkspacePath key are kept", async () => {
		const home = tmp();
		derivedData(home, "App-noplist", undefined);
		const dir = derivedData(home, "App-nokey", undefined);
		writeFileSync(join(dir, "info.plist"), "<plist><dict></dict></plist>");
		expect(await findOrphans(deps(home))).toEqual([]);
	});

	test("workspace on an unmounted volume is kept", async () => {
		const home = tmp();
		derivedData(home, "App-ext", "/Volumes/warden-no-such-volume-7f3a/App.xcworkspace");
		expect(await findOrphans(deps(home))).toEqual([]);
	});

	test("ModuleCache.noindex and other .noindex dirs are not project dirs", async () => {
		const home = tmp();
		const gone = join(home, "gone", "A.xcworkspace");
		derivedData(home, "ModuleCache.noindex", gone);
		derivedData(home, "SymbolCache.noindex", gone);
		expect(await findOrphans(deps(home))).toEqual([]);
	});

	test("a symlinked entry is never followed", async () => {
		const home = tmp();
		const outside = tmp();
		writeFileSync(join(outside, "info.plist"), plist(join(home, "gone", "A.xcworkspace")));
		const root = join(home, "Library", "Developer", "Xcode", "DerivedData");
		mkdirSync(root, { recursive: true });
		symlinkSync(outside, join(root, "App-link"));
		expect(await findOrphans(deps(home))).toEqual([]);
	});

	test("busy: a running xcodebuild naming the dir or its workspace skips it", async () => {
		const home = tmp();
		const gone = join(home, "gone", "A.xcworkspace");
		const dir = derivedData(home, "App-busy", gone);
		const byDir = fakeExec({ ...IDLE, "pgrep -fl xcodebuild": { stdout: `42 xcodebuild -derivedDataPath ${dir}\n` } });
		expect(await findOrphans(deps(home, byDir))).toEqual([]);
		const byWorkspace = fakeExec({ ...IDLE, "pgrep -fl xcodebuild": { stdout: `42 xcodebuild -workspace ${gone}\n` } });
		expect(await findOrphans(deps(home, byWorkspace))).toEqual([]);
	});

	test("an unrelated xcodebuild does not block", async () => {
		const home = tmp();
		derivedData(home, "App-abc", join(home, "gone", "A.xcworkspace"));
		const other = fakeExec({
			...IDLE,
			"pgrep -fl xcodebuild": { stdout: "42 xcodebuild -workspace /elsewhere/B.xcworkspace\n" },
		});
		expect(await findOrphans(deps(home, other))).toHaveLength(1);
	});

	test("fail safe: pgrep that cannot inspect skips everything", async () => {
		const home = tmp();
		derivedData(home, "App-abc", join(home, "gone", "A.xcworkspace"));
		xctestDevices(home, 5 * HOUR);
		const broken = fakeExec({ pgrep: { exitCode: 127, stderr: "not found" }, "du -sk": { stdout: "1\tx\n" } });
		expect(await findOrphans(deps(home, broken))).toEqual([]);
	});

	test("a dir owned by another uid is skipped", async () => {
		const home = tmp();
		derivedData(home, "App-abc", join(home, "gone", "A.xcworkspace"));
		expect(await findOrphans({ ...deps(home), uid: (process.getuid?.() ?? 0) + 1 })).toEqual([]);
	});

	test("not macOS: nothing", async () => {
		const home = tmp();
		derivedData(home, "App-abc", join(home, "gone", "A.xcworkspace"));
		expect(await findOrphans({ ...deps(home), platform: "linux" })).toEqual([]);
	});

	test("du failing sizes the dir as 0 rather than hiding it", async () => {
		const home = tmp();
		derivedData(home, "App-abc", join(home, "gone", "A.xcworkspace"));
		const exec = fakeExec({ ...IDLE, "du -sk": { exitCode: 1 } });
		expect(await findOrphans(deps(home, exec))).toMatchObject([{ kind: "derived-data", bytes: 0 }]);
	});
});

describe("findOrphans XCTestDevices", () => {
	test("idle for over an hour with no processes: removable", async () => {
		const home = tmp();
		const dir = xctestDevices(home, 2 * HOUR);
		expect(await findOrphans(deps(home))).toEqual([{ kind: "xctest-devices", path: dir, bytes: 2048 * 1024 }]);
	});

	test("touched within the hour: kept", async () => {
		const home = tmp();
		xctestDevices(home, 10 * 60_000);
		expect(await findOrphans(deps(home))).toEqual([]);
	});

	test("a live xcodebuild / XCTestDevices process: kept", async () => {
		const home = tmp();
		xctestDevices(home, 5 * HOUR);
		const live = fakeExec({ ...IDLE, "pgrep -f xcodebuild|XCTestDevices": { exitCode: 0, stdout: "99\n" } });
		expect(await findOrphans(deps(home, live))).toEqual([]);
	});

	test("a symlinked XCTestDevices is never followed", async () => {
		const home = tmp();
		const target = tmp();
		mkdirSync(join(home, "Library", "Developer"), { recursive: true });
		symlinkSync(target, join(home, "Library", "Developer", "XCTestDevices"));
		expect(await findOrphans(deps(home))).toEqual([]);
	});
});

describe("removeOrphans", () => {
	test("removes an orphaned DerivedData dir", async () => {
		const home = tmp();
		const dir = derivedData(home, "App-abc", join(home, "gone", "A.xcworkspace"));
		const d = deps(home);
		const found = await findOrphans(d);
		const result = await removeOrphans(found, d);
		expect(result.removed).toEqual(found);
		expect(result.skipped).toEqual([]);
		expect(existsSync(dir)).toBe(false);
	});

	test("skips an entry that became busy after it was found", async () => {
		const home = tmp();
		const dir = derivedData(home, "App-abc", join(home, "gone", "A.xcworkspace"));
		const found = await findOrphans(deps(home));
		const busy = fakeExec({ ...IDLE, "pgrep -fl xcodebuild": { stdout: `7 xcodebuild -derivedDataPath ${dir}\n` } });
		const result = await removeOrphans(found, deps(home, busy));
		expect(result.removed).toEqual([]);
		expect(result.skipped).toMatchObject([{ reason: "xcodebuild is using it" }]);
		expect(existsSync(dir)).toBe(true);
	});

	test("skips an entry whose workspace came back", async () => {
		const home = tmp();
		const ws = join(home, "gone", "A.xcworkspace");
		const dir = derivedData(home, "App-abc", ws);
		const found = await findOrphans(deps(home));
		mkdirSync(ws, { recursive: true });
		const result = await removeOrphans(found, deps(home));
		expect(result.skipped).toMatchObject([{ reason: "workspace exists again" }]);
		expect(existsSync(dir)).toBe(true);
	});

	test("never removes a path outside home or one that became a symlink", async () => {
		const home = tmp();
		const outside = tmp();
		const swapped = join(home, "Library", "Developer", "Xcode", "DerivedData", "App-swap");
		mkdirSync(join(home, "Library", "Developer", "Xcode", "DerivedData"), { recursive: true });
		symlinkSync(outside, swapped);
		const result = await removeOrphans(
			[
				{ kind: "derived-data", path: outside, workspace: "/x", bytes: 1 },
				{ kind: "derived-data", path: swapped, workspace: "/x", bytes: 1 },
			],
			deps(home)
		);
		expect(result.removed).toEqual([]);
		expect(result.skipped).toHaveLength(2);
		expect(existsSync(outside)).toBe(true);
	});

	test("XCTestDevices: simctl --set delete all", async () => {
		const home = tmp();
		const dir = xctestDevices(home, 5 * HOUR);
		const calls: string[][] = [];
		const exec = fakeExec({ ...IDLE, "xcrun simctl --set": {} }, calls);
		const d = deps(home, exec);
		const result = await removeOrphans(await findOrphans(d), d);
		expect(result.removed).toHaveLength(1);
		expect(calls).toContainEqual(["xcrun", "simctl", "--set", dir, "delete", "all"]);
	});

	test("XCTestDevices: falls back to removing the clones when simctl fails", async () => {
		const home = tmp();
		const dir = xctestDevices(home, 5 * HOUR);
		const exec = fakeExec({ ...IDLE, "xcrun simctl --set": { exitCode: 1 } });
		const d = deps(home, exec);
		const result = await removeOrphans(await findOrphans(d), d);
		expect(result.removed).toHaveLength(1);
		expect(existsSync(join(dir, "CLONE-1"))).toBe(false);
		expect(existsSync(dir)).toBe(true);
	});

	test("XCTestDevices: skipped when a process appears after the scan", async () => {
		const home = tmp();
		const dir = xctestDevices(home, 5 * HOUR);
		const found = await findOrphans(deps(home));
		const live = fakeExec({ ...IDLE, "pgrep -f xcodebuild|XCTestDevices": { exitCode: 0, stdout: "99\n" } });
		const result = await removeOrphans(found, deps(home, live));
		expect(result.skipped).toMatchObject([{ reason: "xcodebuild or XCTestDevices process running" }]);
		expect(existsSync(join(dir, "CLONE-1"))).toBe(true);
	});
});
