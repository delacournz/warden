import { afterEach, describe, expect, test } from "bun:test";
import { activeConditions } from "@delacour/warden-core/conditions/conditions";
import type { ConditionArea } from "@delacour/warden-core/conditions/conditions.types";
import { failWith, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { ok } from "@delacour/warden-types/result";
import { updateState } from "../agent-ui/state";
import { cleanupHarnesses, doc, type Harness, harness, LOGIN, UDID } from "./ui.testing";

afterEach(cleanupHarnesses);

type Override = NonNullable<Parameters<typeof harness>[1]>["onCall"];

function setup(platform: "ios" | "android" = "android", onCall?: Override) {
	const h: Harness = harness([snapshotOf(LOGIN)], {
		platform,
		...(onCall ? { onCall } : {}),
		conditions: { open: async () => ok(h.driver), proxyStatus: async () => undefined, proxyPid: () => undefined },
	});
	return h;
}

const row = (h: Harness, area: ConditionArea) =>
	activeConditions(h.c.store(), h.c.store().listLeases()[0]?.id as string).find((r) => r.area === area);

describe("permission", () => {
	test("set applies the pairs to the app, records them and merges a later set", async () => {
		const h = setup();
		updateState(h.c, UDID, (s) => ({ ...s, app: "com.example.app" }));
		expect(await h.run("permission", "set", "location=denied", "camera=granted", "--json")).toBe(0);
		expect(h.driver.callsOf("permissions")[0]).toMatchObject({
			grants: { location: "denied", camera: "granted" },
			opts: { bundleId: "com.example.app" },
		});
		expect(doc(h.c)).toMatchObject({ ok: true, command: "permission set", result: { action: "permission-set" } });
		await h.run("permission", "set", "location=granted");
		expect(row(h, "permission")?.value).toEqual({
			grants: [
				{ bundleId: "com.example.app", permission: "camera", state: "granted" },
				{ bundleId: "com.example.app", permission: "location", state: "granted" },
			],
		});
	});

	test("--app wins over the opened app", async () => {
		const h = setup();
		updateState(h.c, UDID, (s) => ({ ...s, app: "com.example.app" }));
		await h.run("permission", "set", "photos=granted", "--app", "other.app");
		expect(h.driver.callsOf("permissions")[0]?.opts).toEqual({ bundleId: "other.app" });
	});

	test("skipped names come back as warnings", async () => {
		const h = setup("ios", (call) =>
			call.method === "permissions"
				? {
						data: {
							bundleId: "x.y",
							applied: [{ permission: "photos", state: "granted" }],
							skipped: [{ permission: "camera", reason: "no camera on a simulator" }],
						},
					}
				: undefined
		);
		expect(await h.run("permission", "set", "photos=granted", "camera=granted", "--json")).toBe(0);
		expect(doc(h.c).warnings).toEqual(["camera not applied: no camera on a simulator"]);
	});

	test("reset sets every recorded name to unset per app and forgets the row", async () => {
		const h = setup();
		await h.run("permission", "set", "location=denied", "camera=denied");
		expect(await h.run("permission", "reset", "--json")).toBe(0);
		expect(h.driver.callsOf("permissions").at(-1)).toMatchObject({
			grants: { location: "unset", camera: "unset" },
		});
		expect(row(h, "permission")).toBeUndefined();
	});

	test("reset with nothing recorded changes nothing", async () => {
		const h = setup();
		expect(await h.run("permission", "reset", "--json")).toBe(0);
		expect(h.driver.callsOf("permissions")).toHaveLength(0);
		expect(doc(h.c).result.changed).toBe(false);
	});

	test("usage errors: no pairs, a bad pair, an unknown action", async () => {
		const h = setup();
		expect(await h.run("permission", "set", "--json")).toBe(1);
		expect(await h.run("permission", "set", "wifi=granted", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
		expect(await h.run("permission", "forget", "--json")).toBe(1);
		expect(h.driver.callsOf("permissions")).toHaveLength(0);
	});

	test("status prints what is recorded without opening the driver", async () => {
		const h = setup();
		await h.run("permission", "set", "location=denied");
		expect(await h.run("permission", "status", "--json")).toBe(0);
		expect(doc(h.c).result.grants).toHaveLength(1);
	});
});

describe("timezone and locale", () => {
	const london: Override = (call) =>
		call.method === "timezone"
			? { data: { ...(call.tz ? { timezone: call.tz } : {}), previous: "Europe/London" } }
			: undefined;

	test("timezone set records the previous timezone; reset passes it back and forgets the row", async () => {
		const h = setup("android", london);
		expect(await h.run("timezone", "Asia/Tokyo", "--json")).toBe(0);
		expect(row(h, "locale")?.value).toEqual({ timezone: "Asia/Tokyo", previousTimezone: "Europe/London" });
		expect(await h.run("timezone", "reset")).toBe(0);
		expect(h.driver.callsOf("timezone").at(-1)).toMatchObject({ tz: null, opts: { previous: "Europe/London" } });
		expect(row(h, "locale")).toBeUndefined();
	});

	test("a second timezone keeps the first previous one", async () => {
		const h = setup("android", (call) =>
			call.method === "timezone" ? { data: { timezone: call.tz ?? undefined, previous: call.tz } } : undefined
		);
		await h.run("timezone", "Asia/Tokyo");
		await h.run("timezone", "Europe/Paris");
		expect(row(h, "locale")?.value).toMatchObject({ timezone: "Europe/Paris", previousTimezone: "Asia/Tokyo" });
	});

	test("iOS staging is a warning, not a failure", async () => {
		const h = setup("ios", (call) =>
			call.method === "timezone" ? { data: { timezone: "Asia/Tokyo", appliesOnLaunch: true } } : undefined
		);
		expect(await h.run("timezone", "Asia/Tokyo", "--json")).toBe(0);
		expect(doc(h.c).result.staged).toBe(true);
		expect(doc(h.c).warnings[0]).toContain("staged");
	});

	test("locale set uses --app, the opened app, then the recorded one; reset keeps the timezone", async () => {
		const h = setup("android", (call) =>
			call.method === "locale"
				? { data: { ...(call.tag ? { locale: call.tag } : {}), bundleId: "com.example.app" } }
				: undefined
		);
		await h.run("timezone", "Asia/Tokyo");
		await h.run("locale", "fr-FR", "--app", "com.example.app", "--json");
		expect(h.driver.callsOf("locale")[0]).toMatchObject({ tag: "fr-FR", opts: { bundleId: "com.example.app" } });
		expect(row(h, "locale")?.value).toMatchObject({
			locale: "fr-FR",
			bundleId: "com.example.app",
			timezone: "Asia/Tokyo",
		});
		await h.run("locale", "reset");
		expect(h.driver.callsOf("locale").at(-1)).toMatchObject({ tag: null, opts: { bundleId: "com.example.app" } });
		expect(row(h, "locale")?.value).toEqual({ timezone: "Asia/Tokyo" });
	});

	test("status reads the record", async () => {
		const h = setup();
		await h.run("timezone", "Asia/Tokyo");
		expect(await h.run("timezone", "status", "--json")).toBe(0);
		expect(doc(h.c).result.timezone).toBe("Asia/Tokyo");
	});
});

describe("a11y", () => {
	test("set with a name, bold and contrast; recorded with the resolved scale; reset clears", async () => {
		const h = setup();
		expect(await h.run("a11y", "set", "--text-size", "accessibility-large", "--bold", "--contrast", "increased")).toBe(
			0
		);
		expect(h.driver.callsOf("a11y")[0]?.op).toEqual({
			textSize: "accessibility-large",
			boldText: true,
			contrast: "increased",
		});
		expect(row(h, "a11y")?.value).toMatchObject({ textSize: "accessibility-large", fontScale: 1.9, boldText: true });
		expect(await h.run("a11y", "reset")).toBe(0);
		expect(h.driver.callsOf("a11y").at(-1)?.op).toBeNull();
		expect(row(h, "a11y")).toBeUndefined();
	});

	test("a scale and --no-bold", async () => {
		const h = setup();
		await h.run("a11y", "set", "--text-size", "1.5", "--no-bold");
		expect(h.driver.callsOf("a11y")[0]?.op).toEqual({ textSize: 1.5, boldText: false });
	});

	test("usage: nothing to set, a bad size, a bad contrast", async () => {
		const h = setup();
		expect(await h.run("a11y", "set", "--json")).toBe(1);
		expect(await h.run("a11y", "set", "--text-size", "huge", "--json")).toBe(1);
		expect(await h.run("a11y", "set", "--contrast", "max", "--json")).toBe(1);
		expect(h.driver.callsOf("a11y")).toHaveLength(0);
	});

	test("a driver that skips everything fails with its E_UNSUPPORTED", async () => {
		const h = setup("ios", (call) =>
			call.method === "a11y" ? failWith("E_UNSUPPORTED", "boldText: no switch") : undefined
		);
		expect(await h.run("a11y", "set", "--bold", "--json")).toBe(1);
		expect(doc(h.c).error.message).toContain("E_UNSUPPORTED");
	});
});

describe("battery", () => {
	test("set level and charging; recorded; reset", async () => {
		const h = setup();
		expect(await h.run("battery", "set", "--level", "15", "--no-charging", "--json")).toBe(0);
		expect(h.driver.callsOf("battery")[0]?.op).toEqual({ level: 15, charging: false });
		expect(row(h, "battery")?.value).toMatchObject({ level: 15, charging: false });
		expect(await h.run("battery", "reset")).toBe(0);
		expect(h.driver.callsOf("battery").at(-1)?.op).toBeNull();
		expect(row(h, "battery")).toBeUndefined();
	});

	test("a cosmetic result warns", async () => {
		const h = setup("ios", (call) => (call.method === "battery" ? { data: { level: 20, cosmetic: true } } : undefined));
		await h.run("battery", "set", "--level", "20", "--json");
		expect(doc(h.c).warnings[0]).toContain("cosmetic");
		expect(row(h, "battery")?.value).toMatchObject({ cosmetic: true });
	});

	test("usage: nothing to set, a bad level", async () => {
		const h = setup();
		expect(await h.run("battery", "set", "--json")).toBe(1);
		expect(await h.run("battery", "set", "--level", "101", "--json")).toBe(1);
		expect(h.driver.callsOf("battery")).toHaveLength(0);
	});
});

describe("memory-warning and push", () => {
	test("memory-warning goes to --app", async () => {
		const h = setup();
		expect(await h.run("memory-warning", "--app", "com.example.app", "--json")).toBe(0);
		expect(h.driver.callsOf("memoryWarning")[0]?.opts).toEqual({ bundleId: "com.example.app" });
	});

	test("memory-warning surfaces the driver's E_UNSUPPORTED", async () => {
		const h = setup("ios", (call) =>
			call.method === "memoryWarning" ? failWith("E_UNSUPPORTED", "no mechanism") : undefined
		);
		expect(await h.run("memory-warning", "--json")).toBe(1);
		expect(doc(h.c).error.message).toContain("no mechanism");
	});

	test("push takes inline JSON", async () => {
		const h = setup("ios");
		expect(await h.run("push", '{"aps":{"alert":"hi"}}', "--app", "com.example.app", "--json")).toBe(0);
		expect(h.driver.callsOf("push")[0]).toMatchObject({
			payload: { aps: { alert: "hi" } },
			opts: { bundleId: "com.example.app" },
		});
	});

	test("push without aps is a usage error and sends nothing", async () => {
		const h = setup("ios");
		expect(await h.run("push", '{"alert":"hi"}', "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
		expect(h.driver.callsOf("push")).toHaveLength(0);
	});
});
