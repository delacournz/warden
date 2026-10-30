import { afterEach, describe, expect, test } from "bun:test";
import { activeConditions } from "@delacour/warden-core/conditions/conditions";
import { ANDROID_SETTINGS, IOS_SETTINGS, snapshotOf } from "@delacour/warden-e2e/a11y/a11y.fixture";
import type { A11yEvent } from "@delacour/warden-e2e/a11y/a11y.types";
import { failWith } from "@delacour/warden-e2e/driver/driver.testing";
import { ok } from "@delacour/warden-types/result";
import { readState, updateState } from "../agent-ui/state";
import { cleanupHarnesses, doc, type Harness, type HarnessOptions, harness, UDID } from "./ui.testing";

afterEach(cleanupHarnesses);

function ios(options: HarnessOptions = {}): Harness {
	return harness([IOS_SETTINGS], {
		platform: "ios",
		...options,
		driverOptions: { platform: "ios", ...options.driverOptions },
	});
}

function android(options: HarnessOptions = {}): Harness {
	return harness([ANDROID_SETTINGS], {
		platform: "android",
		...options,
		driverOptions: { platform: "android", ...options.driverOptions },
	});
}

const recorded = (h: Harness) =>
	activeConditions(h.c.store(), h.c.store().listLeases()[0]?.id as string).find((r) => r.area === "a11y")?.value;

describe("a11y set: display settings and the screen reader", () => {
	test("each new flag reaches the driver op and the lease's record; --no- turns it off", async () => {
		const h = ios({
			conditions: { open: async () => ok(h.driver), proxyStatus: async () => undefined, proxyPid: () => undefined },
		});
		expect(
			await h.run(
				"a11y",
				"set",
				"--screen-reader",
				"--reduce-transparency",
				"--button-shapes",
				"--differentiate-without-color",
				"--on-off-labels",
				"--no-high-contrast-text",
				"--color-inversion"
			)
		).toBe(0);
		expect(h.driver.callsOf("a11y")[0]?.op).toEqual({
			screenReader: true,
			reduceTransparency: true,
			buttonShapes: true,
			differentiateWithoutColor: true,
			onOffLabels: true,
			highContrastText: false,
			colorInversion: true,
		});
	});

	test("Android TalkBack keeps the services it found; --no-screen-reader drops the record", async () => {
		const previous = { services: "x/y", enabled: "1" };
		const h = android({
			conditions: { open: async () => ok(h.driver), proxyStatus: async () => undefined, proxyPid: () => undefined },
			onCall: (call) =>
				call.method === "a11y" && call.op?.screenReader === true
					? {
							data: {
								applied: ["screenReader"],
								skipped: [],
								notes: [],
								screenReader: { mode: "real", engine: "talkback" },
								screenReaderPrevious: previous,
							},
						}
					: call.method === "a11y" && call.op?.screenReader === false
						? { data: { applied: ["screenReader"], skipped: [], notes: [] } }
						: undefined,
		});
		expect(await h.run("a11y", "set", "--screen-reader", "--json")).toBe(0);
		expect(doc(h.c).result.screenReader).toEqual({ mode: "real", engine: "talkback" });
		expect(recorded(h)).toMatchObject({ screenReader: true, screenReaderPrevious: previous });
		expect(await h.run("a11y", "set", "--no-screen-reader")).toBe(0);
		expect(recorded(h)).toEqual({});
	});

	test("status names the screen reader: simulated on iOS, real on Android, off otherwise", async () => {
		const h = ios({
			conditions: { open: async () => ok(h.driver), proxyStatus: async () => undefined, proxyPid: () => undefined },
		});
		expect(await h.run("a11y", "status", "--json")).toBe(0);
		expect(doc(h.c).result.screenReader).toEqual({ mode: "off" });
		await h.run("a11y", "set", "--screen-reader");
		expect(await h.run("a11y", "status", "--json")).toBe(0);
		expect(doc(h.c).result.screenReader).toEqual({ mode: "simulated", engine: "voiceover" });
		expect(await h.run("a11y", "status")).toBe(0);
		expect(h.c.stdout.join("\n")).toContain("simulated (voiceover");
	});

	test("set with no flag names every flag in the usage error", async () => {
		const h = ios();
		expect(await h.run("a11y", "set", "--json")).toBe(1);
		expect(doc(h.c).error.message).toContain("--screen-reader");
	});
});

describe("a11y audit", () => {
	test("prints the issues and exits 1 when one is an error; the JSON result still carries them", async () => {
		const h = ios();
		expect(await h.run("a11y", "audit", "--no-native", "--json")).toBe(1);
		const out = doc(h.c);
		expect(out).toMatchObject({ ok: true, command: "a11y audit", result: { passed: false, minSeverity: "error" } });
		expect(out.result.issues.map((i: { rule: string }) => i.rule)).toContain("image-no-name");
		expect(out.result.failing).toBeGreaterThan(0);
	});

	test("text output is the formatted table and a verdict line", async () => {
		const h = ios();
		expect(await h.run("a11y", "audit", "--no-native")).toBe(1);
		const text = h.c.stdout.join("\n");
		expect(text).toContain("a11y audit:");
		expect(text).toContain("FAIL:");
	});

	test("--ignore and --rule narrow the audit; nothing left at or above the severity exits 0", async () => {
		const h = ios();
		expect(
			await h.run(
				"a11y",
				"audit",
				"--no-native",
				"--rule",
				"image-no-name",
				"--ignore",
				"image-no-name:settings-avatar"
			)
		).toBe(0);
		expect(h.c.stdout.join("\n")).toContain("ok:");
	});

	test("--min-severity warning counts warnings: the exit follows whether any are left", async () => {
		const h = ios();
		const strict = await h.run("a11y", "audit", "--no-native", "--min-severity", "warning", "--json");
		const out = doc(h.c);
		expect(out.result.minSeverity).toBe("warning");
		expect(out.result.failing).toBe(out.result.issues.length);
		expect(strict).toBe(out.result.issues.length > 0 ? 1 : 0);
		expect(await h.run("a11y", "audit", "--no-native", "--min-severity", "error", "--json")).toBe(
			doc(h.c).result.issues.some((i: { severity: string }) => i.severity === "error") ? 1 : 0
		);
	});

	test("native audit runs by default with the opened app; a skipped engine is a warning, not a failure", async () => {
		const h = ios({
			driverOptions: {
				auditNatively: () => ({
					issues: [],
					skipped: { source: "xcuitest", reason: "runner sources are not bundled" },
				}),
			},
		});
		updateState(h.c, UDID, (s) => ({ ...s, app: "com.example.app" }));
		await h.run("a11y", "audit", "--rule", "native", "--json");
		expect(h.driver.callsOf("auditNatively")[0]?.options).toEqual({ bundleId: "com.example.app" });
		const out = doc(h.c);
		expect(out.result.passed).toBe(true);
		expect(out.warnings[0]).toContain("xcuitest audit skipped");
	});

	test("--no-native never calls the platform audit", async () => {
		const h = ios({ driverOptions: { auditNatively: () => ({ issues: [] }) } });
		await h.run("a11y", "audit", "--no-native", "--json");
		expect(h.driver.callsOf("auditNatively")).toHaveLength(0);
	});

	test("an iOS app launched without the injected library warns once and still audits", async () => {
		const h = ios({
			driverOptions: { readA11y: () => IOS_SETTINGS },
			onCall: (call) => (call.method === "readA11y" ? failWith("E_UNSUPPORTED", "no inject") : undefined),
		});
		await h.run("a11y", "audit", "--no-native", "--json");
		expect(doc(h.c).warnings.join(" ")).toContain("open <bundle> --relaunch --a11y");
	});

	test("usage: an unknown rule, a bad severity or a bad text size exits 1 before touching the device", async () => {
		const h = ios();
		for (const args of [
			["--rule", "nope"],
			["--min-severity", "info"],
			["--text-size", "huge"],
			["--ignore", "x"],
		]) {
			expect(await h.run("a11y", "audit", ...args, "--json")).toBe(1);
			expect(doc(h.c).error.code).toBe("usage");
		}
		expect(h.driver.callsOf("snapshot")).toHaveLength(0);
	});
});

describe("a11y order and speak", () => {
	test("order lists the reading order and says it is simulated", async () => {
		const h = ios();
		expect(await h.run("a11y", "order")).toBe(0);
		const text = h.c.stdout.join("\n");
		expect(text).toContain("simulated");
		expect(text).toContain("Notifications");
		expect(await h.run("a11y", "order", "--json")).toBe(0);
		const out = doc(h.c);
		expect(out.result).toMatchObject({ simulated: true });
		expect(out.result.order[0].source).toBe("simulated");
	});

	test("speak names one element by selector", async () => {
		const h = ios();
		expect(await h.run("a11y", "speak", "label=Notifications", "--json")).toBe(0);
		const out = doc(h.c);
		expect(out.result.simulated).toBe(true);
		expect(out.result.announcement.text).toContain("Notifications");
	});

	test("speak needs a locator and refuses coordinates", async () => {
		const h = ios();
		expect(await h.run("a11y", "speak", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
		expect(await h.run("a11y", "speak", "10", "20", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
	});

	test("speak on a selector that matches nothing is target_not_found", async () => {
		const h = ios();
		expect(await h.run("a11y", "speak", "label=Nope", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("target_not_found");
	});
});

const EVENTS: A11yEvent[] = [
	{ kind: "announcement", text: "Saved", at: 1, source: "inject" },
	{ kind: "layout-changed", at: 2, source: "inject" },
	{ kind: "live-region", text: "3 items", at: 3, source: "inject" },
];

describe("a11y announcements and spoken", () => {
	test("announcements keeps announcements and live regions, prints the cursor, honours --since", async () => {
		const h = ios({
			driverOptions: {
				a11yEvents: (since) => ({
					events: EVENTS.slice((since ?? 0) > 0 ? 2 : 0),
					cursor: 9,
				}),
			},
		});
		expect(await h.run("a11y", "announcements", "--json")).toBe(0);
		const out = doc(h.c);
		expect(out.result.announcements.map((a: { text: string }) => a.text)).toEqual(["Saved", "3 items"]);
		expect(out.result.cursor).toBe(9);
		await h.run("a11y", "announcements", "--since", "4", "--json");
		expect(h.driver.callsOf("a11yEvents").at(-1)?.since).toBe(4);
	});

	test("announcements without the injected library is unsupported with the way out", async () => {
		const h = ios({
			driverOptions: { a11yEvents: () => ({ events: [], cursor: 0 }) },
			onCall: (call) => (call.method === "a11yEvents" ? failWith("E_UNSUPPORTED", "launched without it") : undefined),
		});
		expect(await h.run("a11y", "announcements", "--json")).toBe(1);
		const error = doc(h.c).error;
		expect(error.code).toBe("unsupported");
		expect(error.hint).toContain("--a11y");
	});

	test("a bad cursor is a usage error", async () => {
		const h = ios({ driverOptions: { a11yEvents: () => ({ events: [], cursor: 0 }) } });
		expect(await h.run("a11y", "announcements", "--since", "x", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
	});

	test("spoken prints lines with their source and the cursor", async () => {
		const h = android({
			driverOptions: {
				screenReader: {
					spoken: () => ({ lines: [{ text: "Wi-Fi, switch, on", at: 5, source: "simulated" }], cursor: 7 }),
				},
			},
		});
		expect(await h.run("a11y", "spoken")).toBe(0);
		expect(h.c.stdout.join("\n")).toContain("Wi-Fi, switch, on  (simulated)");
		expect(h.c.stdout.join("\n")).toContain("cursor 7");
	});
});

describe("a11y focus (TalkBack)", () => {
	const row = snapshotOf("android", [{ role: "button", rawType: "Button", label: "Save", traits: ["button"] }]);
	const focused = row.flat[0];
	if (!focused) throw new Error("fixture");

	test("next moves focus and prints what it holds; the end of the screen says so", async () => {
		let i = 0;
		const h = android({ driverOptions: { screenReader: { next: () => (i++ === 0 ? focused : undefined) } } });
		expect(await h.run("a11y", "focus", "next")).toBe(0);
		expect(h.c.stdout.join("\n")).toContain("Save");
		expect(await h.run("a11y", "focus", "next", "--json")).toBe(0);
		expect(doc(h.c).result).toMatchObject({ step: "next", focused: null });
	});

	test("activate and status", async () => {
		const h = android({ driverOptions: { screenReader: { focused: () => focused } } });
		expect(await h.run("a11y", "focus", "activate", "--json")).toBe(0);
		expect(h.driver.callsOf("screenReaderActivate")).toHaveLength(1);
		expect(await h.run("a11y", "focus", "status", "--json")).toBe(0);
		expect(doc(h.c).result).toMatchObject({
			screenReader: { mode: "real", engine: "talkback" },
			focused: { text: expect.stringContaining("Save") },
		});
	});

	test("anywhere TalkBack is not driving it is unsupported, with the way to turn it on", async () => {
		const h = ios();
		expect(await h.run("a11y", "focus", "next", "--json")).toBe(1);
		const error = doc(h.c).error;
		expect(error.code).toBe("unsupported");
		expect(error.hint).toContain("--screen-reader");
	});

	test("a driver E_UNSUPPORTED (TalkBack off) keeps the hint", async () => {
		const h = android({
			driverOptions: { screenReader: {} },
			onCall: (call) => (call.method === "screenReaderNext" ? failWith("E_UNSUPPORTED", "TalkBack is off") : undefined),
		});
		expect(await h.run("a11y", "focus", "next", "--json")).toBe(1);
		expect(doc(h.c).error).toMatchObject({ code: "unsupported" });
	});

	test("a missing or unknown step is a usage error", async () => {
		const h = android({ driverOptions: { screenReader: {} } });
		expect(await h.run("a11y", "focus", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
		expect(await h.run("a11y", "focus", "left", "--json")).toBe(1);
	});
});

describe("snapshot --a11y and open --a11y", () => {
	test("snapshot -i --a11y merges the iOS read and prints the hint column; JSON elements carry a11y", async () => {
		const withHint = IOS_SETTINGS;
		const h = ios({ driverOptions: { readA11y: () => withHint } });
		expect(await h.run("snapshot", "-i", "--a11y")).toBe(0);
		expect(h.driver.callsOf("readA11y")).toHaveLength(1);
		expect(h.c.stdout.join("\n")).toContain('hint="Double tap to toggle"');
		expect(await h.run("snapshot", "-i", "--a11y", "--json")).toBe(0);
		const elements = doc(h.c).result.elements as { a11y?: { hint?: string } }[];
		expect(elements.some((e) => e.a11y?.hint === "Double tap to toggle")).toBe(true);
	});

	test("snapshot without --a11y reads nothing extra", async () => {
		const h = ios({ driverOptions: { readA11y: () => IOS_SETTINGS } });
		await h.run("snapshot", "-i");
		expect(h.driver.callsOf("readA11y")).toHaveLength(0);
	});

	test("snapshot --a11y on an app launched without the library warns", async () => {
		const h = ios({
			driverOptions: { readA11y: () => IOS_SETTINGS },
			onCall: (call) => (call.method === "readA11y" ? failWith("E_UNSUPPORTED", "no inject") : undefined),
		});
		expect(await h.run("snapshot", "-i", "--a11y", "--json")).toBe(0);
		expect(doc(h.c).warnings.join(" ")).toContain("--relaunch --a11y");
	});

	test("open --a11y on iOS is remembered and relaunches the first time only", async () => {
		const h = ios();
		expect(await h.run("open", "com.example.app", "--a11y")).toBe(0);
		expect(readState(h.c, UDID).a11y).toBe(true);
		expect(h.driver.callsOf("app.launch")[0]).toMatchObject({ opts: { relaunch: true } });
		await h.run("open", "com.example.app", "--a11y");
		expect(h.driver.callsOf("app.launch")[1]).toMatchObject({ opts: { relaunch: false } });
	});

	test("open --a11y on Android changes nothing", async () => {
		const h = android();
		await h.run("open", "com.example.app", "--a11y");
		expect(readState(h.c, UDID).a11y).toBeUndefined();
	});
});
