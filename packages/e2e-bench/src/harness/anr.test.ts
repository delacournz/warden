import { describe, expect, test } from "bun:test";
import { anrCloseCenter, anrPackage, dismissAnr, hideErrorDialogs } from "./anr";
import { fakeExec } from "./exec";

const WINDOWS = `  mCurrentFocus=Window{f6704fb u0 Application Not Responding: nz.co.delacour.warden.example}
  mFocusedApp=ActivityRecord{141303490 u0 nz.co.delacour.warden.example/.MainActivity t118}`;

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="android:id/parentPanel" class="android.widget.LinearLayout" bounds="[70,1040][1010,1462]"><node index="0" text="warden-example isn't responding" resource-id="android:id/alertTitle" class="android.widget.TextView" bounds="[133,1087][947,1150]" /><node index="1" text="Close app" resource-id="android:id/aerr_close" class="android.widget.Button" clickable="true" bounds="[70,1189][1010,1315]" /><node index="2" text="Wait" resource-id="android:id/aerr_wait" class="android.widget.Button" clickable="true" bounds="[70,1315][1010,1441]" /></node></hierarchy>`;

describe("anr", () => {
	test("anrPackage reads the ANR window's package from dumpsys", () => {
		expect(anrPackage(WINDOWS)).toBe("nz.co.delacour.warden.example");
		expect(anrPackage("  mCurrentFocus=Window{1 u0 nz.co.delacour.warden.example/.MainActivity}")).toBeUndefined();
	});
	test("anrCloseCenter finds the Close app button", () => {
		expect(anrCloseCenter(DUMP)).toEqual({ x: 540, y: 1252 });
		expect(anrCloseCenter("<hierarchy/>")).toBeUndefined();
	});
	test("dismissAnr is a no-op without an ANR window", async () => {
		const exec = fakeExec([{ cmd: "adb", result: { stdout: "  mCurrentFocus=Window{1 u0 Launcher}" } }]);
		const r = await dismissAnr(exec, "emu");
		expect(r).toEqual({ success: true, data: { dismissed: false } });
		expect(exec.calls).toHaveLength(1);
	});
	test("dismissAnr taps Close app and reports the package", async () => {
		const exec = fakeExec([
			{ cmd: "adb", match: (a) => a.includes("dumpsys"), result: { stdout: WINDOWS } },
			{ cmd: "adb", match: (a) => a.includes("uiautomator"), result: { stdout: DUMP } },
			{ cmd: "adb", result: {} },
		]);
		const r = await dismissAnr(exec, "emu");
		expect(r).toEqual({ success: true, data: { dismissed: true, packageName: "nz.co.delacour.warden.example" } });
		expect(exec.calls[2]?.args).toEqual(["-s", "emu", "shell", "input", "tap", "540", "1252"]);
	});
	test("dismissAnr falls back to BACK when the dump has no button", async () => {
		const exec = fakeExec([
			{ cmd: "adb", match: (a) => a.includes("dumpsys"), result: { stdout: WINDOWS } },
			{ cmd: "adb", match: (a) => a.includes("uiautomator"), result: { stdout: "ERROR: could not get idle state." } },
			{ cmd: "adb", result: {} },
		]);
		const r = await dismissAnr(exec, "emu");
		expect(r.success).toBe(true);
		expect(exec.calls[2]?.args).toEqual(["-s", "emu", "shell", "input", "keyevent", "BACK"]);
	});
	test("hideErrorDialogs writes the global setting", async () => {
		const exec = fakeExec([{ cmd: "adb", result: {} }]);
		expect((await hideErrorDialogs(exec, "emu", true)).success).toBe(true);
		expect(exec.calls[0]?.args).toEqual(["-s", "emu", "shell", "settings", "put", "global", "hide_error_dialogs", "1"]);
		await hideErrorDialogs(exec, "emu", false);
		expect(exec.calls[1]?.args.at(-1)).toBe("0");
	});
});
