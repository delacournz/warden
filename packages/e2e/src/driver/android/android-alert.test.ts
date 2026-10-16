import { describe, expect, test } from "bun:test";
import { detectAlert } from "./android-alert";
import { REAL_ANR_DUMP, REAL_ANR_SCREEN } from "./anr.fixture";
import { parseUiautomatorXml } from "./uiautomator";
import { SYNTHETIC_FORM_DUMP, SYNTHETIC_FORM_SCREEN } from "./uiautomator.fixture";

const SCREEN = { width: 1080, height: 2400 };

function node(cls: string, id: string, text: string, bounds = "[0,0][10,10]", clickable = false): string {
	return `<node index="0" text="${text}" resource-id="${id}" class="${cls}" package="x" content-desc="" checkable="false" checked="false" clickable="${clickable}" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="${bounds}" />`;
}

const wrap = (inner: string) =>
	`<?xml version='1.0' ?><hierarchy rotation="0"><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" enabled="true">${inner}</node></hierarchy>`;

describe("detectAlert", () => {
	test("AlertDialog buttons button1..3 with title and message", () => {
		const xml = wrap(
			node("android.widget.TextView", "android:id/alertTitle", "Delete?") +
				node("android.widget.TextView", "android:id/message", "This cannot be undone") +
				node("android.widget.Button", "android:id/button2", "Cancel", "[0,0][10,10]", true) +
				node("android.widget.Button", "android:id/button1", "OK", "[10,0][20,10]", true)
		);
		const alert = detectAlert(parseUiautomatorXml(xml, SCREEN).flat);
		expect(alert?.title).toBe("Delete?");
		expect(alert?.message).toBe("This cannot be undone");
		expect(alert?.buttons.map((b) => b.text)).toEqual(["Cancel", "OK"]);
	});

	test("permission controller dialog", () => {
		const xml = wrap(
			node(
				"android.widget.TextView",
				"com.google.android.permissioncontroller:id/permission_message",
				"Allow Demo to send you notifications?"
			) +
				node(
					"android.widget.Button",
					"com.google.android.permissioncontroller:id/permission_allow_button",
					"Allow",
					"[0,0][10,10]",
					true
				) +
				node(
					"android.widget.Button",
					"com.google.android.permissioncontroller:id/permission_deny_button",
					"Don't allow",
					"[10,0][20,10]",
					true
				)
		);
		const alert = detectAlert(parseUiautomatorXml(xml, SCREEN).flat);
		expect(alert?.title).toBe("Allow Demo to send you notifications?");
		expect(alert?.buttons.map((b) => b.identifier)).toEqual(["permission_allow_button", "permission_deny_button"]);
	});

	test("the real ANR dialog: Close app and Wait, titled by the app", () => {
		const alert = detectAlert(parseUiautomatorXml(REAL_ANR_DUMP, REAL_ANR_SCREEN).flat);
		expect(alert?.title).toBe("hang isn't responding");
		expect(alert?.message).toBeUndefined();
		expect(alert?.buttons.map((b) => [b.identifier, b.text, b.hittable])).toEqual([
			["aerr_close", "Close app", true],
			["aerr_wait", "Wait", true],
		]);
	});

	test("an ordinary screen has no alert", () => {
		expect(detectAlert(parseUiautomatorXml(SYNTHETIC_FORM_DUMP, SYNTHETIC_FORM_SCREEN).flat)).toBeNull();
		expect(detectAlert([])).toBeNull();
	});
});
