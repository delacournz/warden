import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { el, failWith, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import type { Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import { KEY_PACE_MS } from "@delacour/warden-e2e/driver/typing";
import type { UiDeps } from "../agent-ui/driver";
import { readState } from "../agent-ui/state";
import type { VideoSpec } from "../agent-ui/video";
import { cleanupHarnesses, doc, harness, LOGIN, UDID } from "./ui.testing";

afterEach(cleanupHarnesses);

/** SIGN-IN is the third row of LOGIN: frame (0,150 390×44), centre (195,172). */
const SIGN_IN = { x: 195, y: 172 };

describe("press / tap", () => {
	test("@ref: taps the centre of the element, no snapshot needed", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		await h.run("snapshot");
		const before = h.driver.callsOf("snapshot").length;
		expect(await h.run("press", "@e4", "--json")).toBe(0);
		expect(h.driver.callsOf("tap")).toEqual([{ method: "tap", point: SIGN_IN }]);
		expect(h.driver.callsOf("snapshot")).toHaveLength(before);
		expect(doc(h.c)).toMatchObject({
			ok: true,
			command: "press",
			result: { action: "press", target: { ref: "@e4", point: SIGN_IN } },
		});
	});

	test("selector: resolves against a fresh snapshot; `tap` is an alias", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("tap", "id=sign-in-submit", "--json")).toBe(0);
		expect(h.driver.callsOf("tap")).toEqual([{ method: "tap", point: SIGN_IN }]);
		expect(doc(h.c).result.target).toEqual({ selector: "id=sign-in-submit", point: SIGN_IN });
	});

	test("selector that matches nothing: target_not_found, exit 1, no tap", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("press", "id=nope", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("target_not_found");
		expect(h.driver.callsOf("tap")).toHaveLength(0);
	});

	test("x y: taps that point without looking at the screen", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("press", "120", "340")).toBe(0);
		expect(h.driver.calls.map((call) => call.method)).toEqual(["tap", "close"]);
		expect(h.driver.callsOf("tap")[0]?.point).toEqual({ x: 120, y: 340 });
	});

	test("an @ref older than 30 s is re-verified against a fresh snapshot, then tapped", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		await h.run("snapshot");
		h.clock.t += 31_000;
		const before = h.driver.callsOf("snapshot").length;
		expect(await h.run("press", "@e4", "--json")).toBe(0);
		expect(h.driver.callsOf("snapshot")).toHaveLength(before + 1);
		expect(doc(h.c).result.verified).toBe(true);
	});

	test("an old @ref whose element is gone: stale_ref, exit 4, no tap", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		await h.run("snapshot");
		h.clock.t += 31_000;
		h.driver.set(snapshotOf([el("text", { label: "Elsewhere" })]));
		expect(await h.run("press", "@e4", "--json")).toBe(4);
		expect(doc(h.c).error.code).toBe("stale_ref");
		expect(h.driver.callsOf("tap")).toHaveLength(0);
	});

	test("--verify re-checks a recent @ref too", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		await h.run("snapshot");
		const before = h.driver.callsOf("snapshot").length;
		expect(await h.run("press", "@e4", "--verify", "--json")).toBe(0);
		expect(h.driver.callsOf("snapshot")).toHaveLength(before + 1);
		expect(doc(h.c).result.verified).toBe(true);
	});

	test("--settle waits for two equal hashes >= 250 ms apart and reports the diff", async () => {
		const after = snapshotOf([el("text", { label: "Signed in" })]);
		let tapped = false;
		const h = harness(() => (tapped ? after : snapshotOf(LOGIN)), {
			onCall: (call) => {
				if (call.method === "tap") tapped = true;
				return undefined;
			},
		});
		await h.run("snapshot");
		const start = h.clock.t;
		expect(await h.run("press", "@e4", "--settle", "--json")).toBe(0);
		const out = doc(h.c);
		expect(out.generation).toBe(2);
		expect(out.result.settled.quiet).toBe(true);
		expect(out.result.settled.waitedMs).toBeGreaterThanOrEqual(250);
		expect(h.clock.t - start).toBeGreaterThanOrEqual(250);
		expect(out.result.settled.diff.against).toBe(1);
		expect(out.result.settled.diff.added.map((e: { line: string }) => e.line)).toEqual([
			'[text] "Signed in" enabled (0,0 390×44)',
		]);
	});

	test("--settle in text mode prints the verdict and the diff", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		await h.run("snapshot");
		expect(await h.run("press", "@e4", "--settle")).toBe(0);
		const text = h.c.stdout.join("\n");
		expect(text).toContain("pressed @e4");
		expect(text).toContain("# settled after");
		expect(text).toContain("# diff vs generation 1");
	});

	test("every action is appended to the recording; --no-record skips it", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		await h.run("press", "id=sign-in-submit");
		expect(h.steps).toMatchObject([{ action: "press", target: { selector: "id=sign-in-submit", point: SIGN_IN } }]);
		expect(h.steps[0]?.evidence?.element.identifier).toBe("sign-in-submit");
		await h.run("press", "10", "20", "--no-record");
		expect(h.steps).toHaveLength(1);
	});
});

describe("longpress", () => {
	test("default 800 ms, explicit ms after a ref, and x y with / without ms", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		await h.run("snapshot");
		await h.run("longpress", "@e4");
		await h.run("longpress", "@e4", "700");
		await h.run("longpress", "100", "200");
		await h.run("longpress", "100", "200", "500");
		expect(h.driver.callsOf("longPress")).toEqual([
			{ method: "longPress", point: SIGN_IN, opts: { durationMs: 800 } },
			{ method: "longPress", point: SIGN_IN, opts: { durationMs: 700 } },
			{ method: "longPress", point: { x: 100, y: 200 }, opts: { durationMs: 800 } },
			{ method: "longPress", point: { x: 100, y: 200 }, opts: { durationMs: 500 } },
		]);
	});
});

/** Replace the email field's value when the driver types, so the read-back sees it. */
function typingScreen(value: string): Snapshot {
	return snapshotOf([
		el("window", {
			children: [
				el("text", { label: "Welcome" }),
				el("textfield", { label: "Email", id: "email", value }),
				el("button", { label: "Sign in", id: "sign-in-submit" }),
			],
		}),
	]);
}

describe("fill", () => {
	test("focuses at the caret, backspaces the old text, types, and confirms by reading back", async () => {
		let typed = "";
		const h = harness([typingScreen("a@b.co")], {
			onCall: (call, driver) => {
				if (call.method === "typeText") {
					typed += call.text;
					driver.set(typingScreen(typed));
				}
				return undefined;
			},
		});
		expect(await h.run("fill", "id=email", "new@x.co", "--json")).toBe(0);
		const methods: string[] = h.driver.calls
			.map((call) => call.method)
			.filter((m) => m !== "snapshot" && m !== "elementAtPoint");
		const backspaces: string[] = Array.from({ length: 7 }, () => "key");
		const characters: string[] = Array.from({ length: 8 }, () => "typeText");
		expect(methods).toEqual(["tap", ...backspaces, ...characters, "close"]);
		expect(h.driver.callsOf("tap")[0]?.point).toEqual({ x: 351, y: 122 });
		expect(h.driver.callsOf("key").every((call) => call.key === "Backspace")).toBe(true);
		expect(h.driver.callsOf("typeText").map((call) => call.text)).toEqual([..."new@x.co"]);
		expect(h.clock.t - 1_000_000).toBeGreaterThanOrEqual(15 * KEY_PACE_MS);
		expect(doc(h.c).result).toMatchObject({ action: "fill", verified: true, characters: 8 });
		expect(h.steps[0]?.args).toEqual({ text: "new@x.co" });
	});

	test("a field that does not take the text: retried once, then failed with what it holds", async () => {
		const h = harness([typingScreen("old")]);
		expect(await h.run("fill", "id=email", "new", "--json")).toBe(1);
		const out = doc(h.c);
		expect(out.error.code).toBe("failed");
		expect(out.error.message).toBe('fill did not take: expected "new" but the field holds "old"');
		expect(h.driver.callsOf("typeText")).toHaveLength(6);
	});

	test("--secure: no read-back, reported as unconfirmed, the text is neither echoed nor recorded", async () => {
		const h = harness([typingScreen("")]);
		expect(await h.run("fill", "id=email", "hunter2hunter2", "--secure")).toBe(0);
		expect(h.c.stdout.join("\n")).toContain("(unconfirmed)");
		expect(h.c.stdout.join("\n")).not.toContain("hunter2");
		expect(
			h.driver
				.callsOf("typeText")
				.map((call) => call.text)
				.join("")
		).toBe("hunter2hunter2");
		expect(h.steps[0]?.args).toEqual({ secure: true });
		await h.run("fill", "id=email", "hunter2hunter2", "--secure", "--json");
		expect(doc(h.c).result).toMatchObject({ verified: "unconfirmed", secure: true, characters: 14 });
		expect(h.c.stdout[0]).not.toContain("hunter2");
	});

	test("--no-verify types without reading back", async () => {
		const h = harness([typingScreen("")]);
		expect(await h.run("fill", "id=email", "x", "--no-verify", "--json")).toBe(0);
		expect(doc(h.c).result.verified).toBeUndefined();
		expect(h.driver.callsOf("snapshot")).toHaveLength(1);
	});

	test("an x y target is typed into unconfirmed", async () => {
		const h = harness([typingScreen("")]);
		expect(await h.run("fill", "50", "60", "abc", "--json")).toBe(0);
		expect(doc(h.c).result.verified).toBe("unconfirmed");
		expect(h.driver.callsOf("tap")[0]?.point).toEqual({ x: 50, y: 60 });
	});

	test("needs a target and a text", async () => {
		const h = harness([typingScreen("")]);
		expect(await h.run("fill", "id=email", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
	});
});

describe("type / key", () => {
	test("type --submit types then presses Enter", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("type", "hello", "--submit", "--json")).toBe(0);
		expect(h.driver.calls.filter((call) => call.method === "typeText" || call.method === "key")).toEqual([
			...[..."hello"].map((text) => ({ method: "typeText" as const, text })),
			{ method: "key", key: "Enter" },
		]);
		expect(doc(h.c).result).toMatchObject({ action: "type", submitted: true });
	});

	test("key accepts any case and rejects unknown names", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("key", "enter")).toBe(0);
		expect(h.driver.callsOf("key")).toEqual([{ method: "key", key: "Enter" }]);
		expect(await h.run("key", "f13", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
	});
});

describe("swipe", () => {
	test("a direction is the way the finger moves, across the middle of the screen", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("swipe", "up")).toBe(0);
		expect(h.driver.callsOf("swipe")).toEqual([
			{
				method: "swipe",
				from: { x: 195, y: 633 },
				to: { x: 195, y: 211 },
				opts: { durationMs: 350, momentum: false },
			},
		]);
	});

	test("`swipe up` (finger direction) and `scroll down` (content direction) are the same gesture", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		await h.run("swipe", "up");
		await h.run("scroll", "down");
		const [finger, content] = h.driver.callsOf("swipe");
		expect(finger).toMatchObject({ from: content?.from, to: content?.to });
	});

	test("x1 y1 x2 y2 is used as given", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("swipe", "10", "20", "30", "40")).toBe(0);
		expect(h.driver.callsOf("swipe")[0]).toMatchObject({ from: { x: 10, y: 20 }, to: { x: 30, y: 40 } });
	});

	test("--from swipes inside that element", async () => {
		const list = snapshotOf([
			el("window", { children: [el("list", { id: "list", frame: { x: 20, y: 100, width: 350, height: 400 } })] }),
		]);
		const h = harness([list]);
		expect(await h.run("swipe", "left", "--from", "id=list")).toBe(0);
		expect(h.driver.callsOf("swipe")[0]).toMatchObject({
			from: { x: 195 + 87.5, y: 300 },
			to: { x: 195 - 87.5, y: 300 },
		});
	});

	test("nonsense: usage error", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("swipe", "sideways", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
	});
});

const FOOTER = el("button", { label: "Footer", id: "footer", frame: { x: 0, y: 700, width: 390, height: 44 } });

describe("scroll", () => {
	test("scroll down moves the finger up (content reveals what is below)", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("scroll", "down")).toBe(0);
		expect(h.driver.callsOf("swipe")[0]).toMatchObject({ from: { x: 195, y: 633 }, to: { x: 195, y: 211 } });
	});

	test("amount is the share of the region one swipe travels; --in picks the region", async () => {
		const list = snapshotOf([
			el("window", { children: [el("list", { id: "list", frame: { x: 20, y: 100, width: 350, height: 400 } })] }),
		]);
		const h = harness([list]);
		expect(await h.run("scroll", "down", "0.25", "--in", "id=list")).toBe(0);
		expect(h.driver.callsOf("swipe")[0]).toMatchObject({ from: { x: 195, y: 350 }, to: { x: 195, y: 250 } });
		expect(await h.run("scroll", "down", "2", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
	});

	test("--until stops as soon as the selector is on screen and returns its fresh @ref", async () => {
		let swipes = 0;
		const h = harness(() => snapshotOf(swipes >= 2 ? [...LOGIN, FOOTER] : LOGIN), {
			onCall: (call) => {
				if (call.method === "swipe") swipes += 1;
				return undefined;
			},
		});
		expect(await h.run("scroll", "down", "--until", "id=footer", "--json")).toBe(0);
		expect(h.driver.callsOf("swipe")).toHaveLength(2);
		const out = doc(h.c);
		expect(out.result).toMatchObject({ action: "scroll", swipes: 2, target: { selector: "id=footer" } });
		expect(out.result.target.ref).toMatch(/^@e\d+$/);
		expect(out.generation).toBeUndefined();
		expect(readState(h.c, UDID).generation).toBe(1);
	});

	test("--until finds an already visible element without swiping", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("scroll", "down", "--until", "id=email")).toBe(0);
		expect(h.driver.callsOf("swipe")).toHaveLength(0);
	});

	test("--until gives up after --max swipes with target_not_found", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("scroll", "down", "--until", "id=footer", "--max", "3", "--json")).toBe(1);
		expect(doc(h.c).error).toMatchObject({ code: "target_not_found", details: { swipes: 3 } });
		expect(h.driver.callsOf("swipe")).toHaveLength(3);
	});

	test("an element below the screen edge does not count as visible", async () => {
		const offscreen = el("button", { label: "Far", id: "far", frame: { x: 0, y: 900, width: 390, height: 44 } });
		const h = harness([snapshotOf([...LOGIN, offscreen])]);
		expect(await h.run("scroll", "down", "--until", "id=far", "--max", "2")).toBe(1);
		expect(h.driver.callsOf("swipe")).toHaveLength(2);
	});

	test("the default budget is 10 swipes", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("scroll", "down", "--until", "id=footer")).toBe(1);
		expect(h.driver.callsOf("swipe")).toHaveLength(10);
	});
});

const ALERT = snapshotOf([
	el("alert", {
		label: "Allow notifications?",
		children: [
			el("text", { label: "Allow notifications?" }),
			el("text", { label: "Alerts may include sounds" }),
			el("button", { label: "Don't Allow", frame: { x: 50, y: 500, width: 100, height: 40 } }),
			el("button", { label: "Allow", frame: { x: 200, y: 500, width: 100, height: 40 } }),
		],
	}),
]);

describe("alert", () => {
	test("accept presses Allow, dismiss presses Don't Allow", async () => {
		const h = harness([ALERT]);
		expect(await h.run("alert", "accept")).toBe(0);
		expect(await h.run("alert", "dismiss")).toBe(0);
		expect(h.driver.callsOf("tap").map((call) => call.point)).toEqual([
			{ x: 250, y: 520 },
			{ x: 100, y: 520 },
		]);
	});

	test("get reads the alert", async () => {
		const h = harness([ALERT]);
		expect(await h.run("alert", "get", "--json")).toBe(0);
		expect(doc(h.c).result.alert).toEqual({
			title: "Allow notifications?",
			message: "Alerts may include sounds",
			buttons: ["Don't Allow", "Allow"],
		});
		expect(doc(h.c).result).toMatchObject({ present: true, buttons: ["Don't Allow", "Allow"] });
		expect(h.driver.callsOf("tap")).toHaveLength(0);
	});

	test("no alert showing: get is ok with no buttons, accept and dismiss are no_alert", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("alert", "get", "--json")).toBe(0);
		expect(doc(h.c).result).toMatchObject({ action: "alert", present: false, alert: null, buttons: [] });
		expect(await h.run("alert", "get")).toBe(0);
		expect(h.c.stdout.join("\n")).toBe("no alert showing");
		for (const choice of ["accept", "dismiss"]) {
			expect(await h.run("alert", choice, "--json")).toBe(1);
			const out = doc(h.c);
			expect(out.ok).toBe(false);
			expect(out.error.code).toBe("no_alert");
			expect(out.error.message).toBe(`no alert is showing to ${choice}`);
		}
		expect(h.driver.callsOf("tap")).toHaveLength(0);
		expect(await h.run("alert", "maybe", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
	});
});

const OPEN_SHEET = snapshotOf([
	el("sheet", {
		children: [
			el("text", { label: "Open in “App”?" }),
			el("button", { label: "Cancel", frame: { x: 50, y: 600, width: 100, height: 40 } }),
			el("button", { label: "Open", frame: { x: 200, y: 600, width: 100, height: 40 } }),
		],
	}),
]);

describe("open", () => {
	test("a bundle id launches the app and is remembered for `close --app`", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("open", "com.example.app", "--json")).toBe(0);
		expect(h.driver.callsOf("app.launch")).toEqual([
			{ method: "app.launch", bundleId: "com.example.app", opts: { relaunch: false } },
		]);
		expect(readState(h.c, UDID).app).toBe("com.example.app");
		expect(doc(h.c).result).toMatchObject({ action: "open", bundleId: "com.example.app", relaunch: false });
	});

	test("--relaunch terminates first (driver relaunch); --metro launches the dev client with --initialUrl and stores the url", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(
			await h.run("open", "com.example.app", "--relaunch", "--metro", "http://localhost:8081", "--args", "--foo", "bar")
		).toBe(0);
		expect(h.driver.callsOf("app.launch")).toEqual([
			{
				method: "app.launch",
				bundleId: "com.example.app",
				opts: { args: ["--initialUrl", "http://localhost:8081", "--foo", "bar"], relaunch: true },
			},
		]);
		expect(readState(h.c, UDID)).toMatchObject({ app: "com.example.app", metroUrl: "http://localhost:8081" });
	});

	test("a url is opened and the iOS `Open in …?` sheet is accepted", async () => {
		const h = harness([snapshotOf(LOGIN)], {
			onCall: (call, driver) => {
				if (call.method === "app.openUrl") driver.set(OPEN_SHEET);
				if (call.method === "tap") driver.set(snapshotOf(LOGIN));
				return undefined;
			},
		});
		expect(await h.run("open", "myapp://settings", "--json")).toBe(0);
		expect(h.driver.callsOf("app.openUrl")).toEqual([{ method: "app.openUrl", url: "myapp://settings" }]);
		expect(h.driver.callsOf("tap").map((call) => call.point)).toEqual([{ x: 250, y: 620 }]);
		expect(readState(h.c, UDID).app).toBeUndefined();
	});

	test("--metro with a url is a usage error", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("open", "myapp://x", "--metro", "http://localhost:8081", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
	});

	test("a failed launch is reported with the driver code, exit 1", async () => {
		const h = harness([snapshotOf(LOGIN)], {
			onCall: (call) => (call.method === "app.launch" ? failWith("E_APP_UNAVAILABLE", "not installed") : undefined),
		});
		expect(await h.run("open", "com.example.app", "--json")).toBe(1);
		expect(doc(h.c).error.message).toBe("E_APP_UNAVAILABLE: not installed");
		expect(readState(h.c, UDID).app).toBeUndefined();
	});
});

describe("device controls", () => {
	test("home presses home; back is Android only", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("home")).toBe(0);
		expect(h.driver.callsOf("pressButton")).toEqual([{ method: "pressButton", button: "home" }]);
		expect(await h.run("back", "--json")).toBe(1);
		expect(doc(h.c).error.message).toContain("Android only");
	});

	test("rotate sets (and reads) the orientation", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("rotate", "landscape-left", "--json")).toBe(0);
		expect(h.driver.callsOf("orientation")).toEqual([{ method: "orientation", set: "landscapeLeft" }]);
		expect(doc(h.c).result.orientation).toBe("landscapeLeft");
		expect(await h.run("rotate", "--json")).toBe(0);
		expect(doc(h.c).result.orientation).toBe("landscapeLeft");
		expect(await h.run("rotate", "sideways", "--json")).toBe(1);
	});

	test("appearance sets (and reads) light / dark", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("appearance", "dark", "--json")).toBe(0);
		expect(h.driver.callsOf("appearance")).toEqual([{ method: "appearance", set: "dark" }]);
		expect(await h.run("appearance", "--json")).toBe(0);
		expect(doc(h.c).result.appearance).toBe("dark");
		expect(await h.run("appearance", "blue", "--json")).toBe(1);
	});

	test("screenshot numbers its files under $WARDEN_HOME/ui/<udid>/shots, or goes where told", async () => {
		const h = harness([snapshotOf(LOGIN)], {
			onCall: (call) => {
				if (call.method === "screenshot" && call.opts?.path) writeFileSync(call.opts.path, "png");
				return undefined;
			},
		});
		await h.run("screenshot", "--json");
		const first: string = doc(h.c).result.path;
		expect(first).toMatch(new RegExp(`/ui/${UDID}/shots/001\\.png$`));
		expect(h.driver.callsOf("screenshot")[0]?.opts?.path).toBe(first);
		await h.run("screenshot", "--json");
		expect(doc(h.c).result.path).toMatch(/\/shots\/002\.png$/);
		await h.run("screenshot", "out/shot.png", "--json");
		expect(doc(h.c).result.path).toBe(`${h.c.cwd}/out/shot.png`);
	});
});

describe("video", () => {
	function fakeVideo() {
		const specs: VideoSpec[] = [];
		const signals: string[] = [];
		let alive = false;
		const video: NonNullable<UiDeps["video"]> = {
			spawnDetached: (spec) => {
				specs.push(spec);
				alive = true;
				return { pid: 4242 };
			},
			kill: (_pid, signal) => {
				signals.push(signal);
				alive = false;
			},
			pidAlive: () => alive,
		};
		return { video, specs, signals };
	}

	test("iOS: start spawns simctl recordVideo and remembers the pid; stop sends SIGINT and forgets it", async () => {
		const fake = fakeVideo();
		const h = harness([snapshotOf(LOGIN)], { video: fake.video });
		expect(await h.run("video", "start", "--json")).toBe(0);
		const path: string = doc(h.c).result.path;
		expect(path).toMatch(new RegExp(`/ui/${UDID}/videos/001\\.mp4$`));
		expect(fake.specs[0]?.argv).toEqual([
			"xcrun",
			"simctl",
			"io",
			UDID,
			"recordVideo",
			"--codec=h264",
			"--force",
			path,
		]);
		expect(readState(h.c, UDID).video).toMatchObject({ pid: 4242, path });

		expect(await h.run("video", "start", "--json")).toBe(1);
		expect(doc(h.c).error.message).toContain("already recording");

		expect(await h.run("video", "stop", "--json")).toBe(0);
		expect(fake.signals).toEqual(["SIGINT"]);
		expect(doc(h.c).result).toEqual({ action: "video", state: "stopped", path });
		expect(readState(h.c, UDID).video).toBeUndefined();
		expect(await h.run("video", "stop", "--json")).toBe(1);
	});

	test("a recorder that ignores SIGINT is killed with a warning", async () => {
		const fake = fakeVideo();
		fake.video.kill = (_pid, signal) => {
			fake.signals.push(signal);
			if (signal === "SIGKILL") return;
		};
		const h = harness([snapshotOf(LOGIN)], { video: fake.video });
		await h.run("video", "start");
		expect(await h.run("video", "stop", "--json")).toBe(0);
		expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
		expect(doc(h.c).warnings?.[0]).toContain("ignored SIGINT");
	});
});
