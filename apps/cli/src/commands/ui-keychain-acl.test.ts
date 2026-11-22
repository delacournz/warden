import { afterEach, describe, expect, test } from "bun:test";
import { ok } from "@delacour/warden-types/result";
import { cleanupHarnesses, doc, type HarnessOptions, harness } from "./ui.testing";

afterEach(cleanupHarnesses);

const ios = (options: HarnessOptions = {}) =>
	harness([], {
		platform: "ios",
		...options,
		driverOptions: { platform: "ios", keychainAcl: true, ...options.driverOptions },
	});

describe("ui open --keychain-acl", () => {
	test("turns the shim on through the driver before the launch; an app started without it is relaunched", async () => {
		const h = ios({
			onCall: (call) =>
				call.method === "keychainAcl" ? ok({ enabled: true, generation: 0, appliesOnLaunch: true }) : undefined,
		});
		expect(await h.run("open", "com.example.app", "--keychain-acl")).toBe(0);
		expect(h.driver.callsOf("keychainAcl")).toEqual([{ method: "keychainAcl", op: { kind: "on" } }]);
		expect(h.driver.callsOf("app.launch")[0]).toMatchObject({ opts: { relaunch: true } });
	});

	test("already live in the running app: no relaunch", async () => {
		const h = ios();
		expect(await h.run("open", "com.example.app", "--keychain-acl")).toBe(0);
		expect(h.driver.callsOf("app.launch")[0]).toMatchObject({ opts: { relaunch: false } });
	});

	test("--no-keychain-acl turns it off; neither flag never touches it", async () => {
		const h = ios();
		expect(await h.run("open", "com.example.app", "--no-keychain-acl")).toBe(0);
		expect(h.driver.callsOf("keychainAcl")).toEqual([{ method: "keychainAcl", op: { kind: "off" } }]);
		expect(await h.run("open", "com.example.app")).toBe(0);
		expect(h.driver.callsOf("keychainAcl")).toHaveLength(1);
	});

	test("on a device without Face ID / Touch ID enrolled it warns, and still turns it on", async () => {
		const h = ios();
		expect(await h.run("open", "com.example.app", "--keychain-acl", "--json")).toBe(0);
		expect(doc(h.c).warnings.join(" ")).toContain("--biometrics");
		expect(h.driver.callsOf("keychainAcl")).toHaveLength(1);
	});

	test("an enrolled device gets no warning", async () => {
		const h = ios({
			onCall: (call) => (call.method === "biometrics" ? ok({ enrolled: true, modality: "face" as const }) : undefined),
		});
		expect(await h.run("open", "com.example.app", "--keychain-acl", "--json")).toBe(0);
		expect(doc(h.c).warnings ?? []).toEqual([]);
	});

	test("a driver with no shim (Android, a phone) fails with unsupported and does not launch", async () => {
		const h = harness([], { platform: "android", driverOptions: { platform: "android" } });
		expect(await h.run("open", "com.example.app", "--keychain-acl", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("unsupported");
		expect(doc(h.c).error.message).toContain("iOS simulators");
		expect(h.driver.callsOf("app.launch")).toHaveLength(0);
	});

	test("a URL refuses it like the other launch flags", async () => {
		const h = ios();
		expect(await h.run("open", "https://example.com", "--keychain-acl", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
	});
});
