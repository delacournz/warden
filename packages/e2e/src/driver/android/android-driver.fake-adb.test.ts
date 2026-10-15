import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec, type Exec } from "@delacour/warden-core/exec";
import { spawnAdb } from "./adb-session";
import { openAndroidDriver } from "./android-driver";
import { SYNTHETIC_FORM_DUMP } from "./uiautomator.fixture";

/** End to end through real child processes: default spawn, `bunExec`, `bunExecBinary` against fake-adb.ts. */

const FAKE_ADB = join(import.meta.dir, "../../../native/scripts/fake-adb.ts");
const dir = mkdtempSync(join(tmpdir(), "wdn-fake-adb-"));
const dumpFile = join(dir, "dump.xml");
writeFileSync(dumpFile, SYNTHETIC_FORM_DUMP);
const rulesFile = join(dir, "rules.json");
writeFileSync(
	rulesFile,
	JSON.stringify({
		rules: [
			{ match: "getprop sys.boot_completed", stdout: "1\n" },
			{ match: "wm size", stdout: "Physical size: 1080x2400\n" },
			{ match: "wm density", stdout: "Physical density: 420\n" },
			{ match: "uiautomator dump /dev/stdout", stdout: "UI hierchary dumped to: /dev/stdout\n" },
			{ match: "exec-out uiautomator dump /dev/tty", stdoutFile: dumpFile },
			{ match: "install -r", stdout: "Success\n" },
			{ match: "input ", stdout: "" },
			{ match: "settings put", stdout: "" },
		],
	})
);

const env = { FAKE_ADB_RULES: rulesFile };
const exec: Exec = (cmd, opts) => bunExec(cmd, { ...opts, env });

describe("android driver against fake-adb.ts", () => {
	test("open, snapshot via the tty route, tap, screenshot, install", async () => {
		const lines: string[] = [];
		const opened = await openAndroidDriver({
			serial: "emulator-5554",
			adb: FAKE_ADB,
			exec,
			spawn: (argv) => spawnAdb(argv, env),
			log: (l) => lines.push(l),
		});
		if (!opened.success) throw new Error(opened.error.message);
		const driver = opened.data;
		try {
			const snap = await driver.snapshot();
			expect(snap.success && snap.data.flat.some((e) => e.identifier === "login-button")).toBe(true);
			expect(lines.some((l) => l.includes("route: tty"))).toBe(true);
			expect((await driver.tap({ x: 10, y: 10 })).success).toBe(true);
			expect(lines.some((l) => /^tap 10,10 x1 in \d+ms$/.test(l))).toBe(true);
			const shot = await driver.screenshot();
			expect(shot.success && shot.data.png?.slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
			expect((await driver.app.install("/x.apk")).success).toBe(true);
		} finally {
			await driver.close();
		}
	});
});
