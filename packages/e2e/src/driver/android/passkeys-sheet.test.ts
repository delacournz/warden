import { describe, expect, test } from "bun:test";
import type { PasskeyCredential } from "@delacour/warden-core/conditions/conditions.types";
import type { Element } from "../driver.types";
import { detectPasskeySheet, sheetAction } from "./passkeys-sheet";

let n = 0;
function node(over: Partial<Element>): Element {
	n++;
	return {
		id: `0.${n}`,
		role: "button",
		rawType: "android.view.View",
		frame: { x: 0, y: n * 10, width: 100, height: 10 },
		normFrame: { x: 0, y: 0, width: 0, height: 0 },
		traits: [],
		enabled: true,
		depth: 1,
		children: [],
		...over,
	};
}
const text = (t: string): Element => node({ role: "text", text: t });
const label = (l: string): Element => node({ label: l });

const create = [
	text("Create passkey to sign in to Example?"),
	label("Close"),
	text("Save another way"),
	text("Continue"),
];
const choose = [
	text("Choose a saved passkey for Example"),
	label("Close"),
	text("alice"),
	text("bob"),
	text("Sign-in options"),
];
const emptyGet = [label("Close sheet"), text("Sign in another way"), text("View options"), label("Dismiss")];
const emptyCreate = [label("Close sheet"), text("Create passkey on another device?")];

function cred(userName: string, createdAt: number): PasskeyCredential {
	return {
		credentialId: userName,
		rpId: "example.com",
		userHandle: "h",
		userName,
		displayName: userName,
		privateKey: "k",
		signCount: 0,
		createdAt,
		backupEligible: true,
		backupState: true,
	};
}

describe("detectPasskeySheet", () => {
	test("create sheet: Continue next to Save another way", () => {
		const sheet = detectPasskeySheet(create);
		expect(sheet?.kind).toBe("create");
	});

	test("an app's own Continue button is not the sheet", () => {
		expect(detectPasskeySheet([text("Continue"), text("Welcome")])).toBeNull();
	});

	test("choose sheet", () => {
		expect(detectPasskeySheet(choose)?.kind).toBe("choose");
	});

	test("GMS empty chooser for get (Dismiss) and create (Close sheet + the another-device text)", () => {
		expect(detectPasskeySheet(emptyGet)?.kind).toBe("empty");
		expect(detectPasskeySheet(emptyCreate)?.kind).toBe("empty");
		expect(detectPasskeySheet([label("Close sheet"), text("Welcome")])).toBeNull();
	});

	test("an app screen with a Dismiss button alone is not the sheet", () => {
		expect(detectPasskeySheet([label("Dismiss"), text("Notification")])).toBeNull();
	});
});

describe("sheetAction", () => {
	const creds = [cred("alice", 1), cred("bob", 2)];

	test("create: continue in auto, cancel and fail (the provider answers per mode)", () => {
		for (const mode of ["auto", "cancel", "fail"] as const) {
			const sheet = detectPasskeySheet(create);
			if (sheet === null) throw new Error("no sheet");
			const action = sheetAction(sheet, create, mode, creds);
			expect(action.do === "tap" && action.element.text).toBe("Continue");
		}
	});

	test("choose: the newest passkey", () => {
		const sheet = detectPasskeySheet(choose);
		if (sheet === null) throw new Error("no sheet");
		const action = sheetAction(sheet, choose, "auto", creds);
		expect(action.do === "tap" && action.element.text).toBe("bob");
	});

	test("choose with no listed passkey leaves the sheet", () => {
		const sheet = detectPasskeySheet(choose);
		if (sheet === null) throw new Error("no sheet");
		expect(sheetAction(sheet, choose, "auto", [cred("zed", 1)]).do).toBe("leave");
	});

	test("unavailable closes create and choose sheets", () => {
		for (const flat of [create, choose]) {
			const sheet = detectPasskeySheet(flat);
			if (sheet === null) throw new Error("no sheet");
			const action = sheetAction(sheet, flat, "unavailable", creds);
			expect(action.do === "tap" && action.element.label).toBe("Close");
		}
	});

	test("the GMS empty chooser is dismissed in every mode but off", () => {
		const sheet = detectPasskeySheet(emptyGet);
		if (sheet === null) throw new Error("no sheet");
		for (const mode of ["auto", "cancel", "fail", "unavailable"] as const) {
			const action = sheetAction(sheet, emptyGet, mode, creds);
			expect(action.do === "tap" && action.element.label).toBe("Dismiss");
		}
		expect(sheetAction(sheet, emptyGet, "off", creds).do).toBe("leave");
	});

	test("off leaves everything", () => {
		const sheet = detectPasskeySheet(create);
		if (sheet === null) throw new Error("no sheet");
		expect(sheetAction(sheet, create, "off", creds).do).toBe("leave");
	});
});
