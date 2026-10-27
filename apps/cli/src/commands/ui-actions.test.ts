import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { el, failWith, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import type { Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import type { UiDeps } from "../agent-ui/driver";
import { readState, updateState } from "../agent-ui/state";
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
		await h.run("gesture", "longpress", "@e4");
		await h.run("gesture", "longpress", "@e4", "700");
		await h.run("gesture", "longpress", "100", "200");
		await h.run("gesture", "longpress", "100", "200", "500");
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
		expect(methods).toEqual(["tap", ...backspaces, "typeText", "close"]);
		expect(h.driver.callsOf("tap")[0]?.point).toEqual({ x: 351, y: 122 });
		expect(h.driver.callsOf("key").every((call) => call.key === "Backspace")).toBe(true);
		expect(h.driver.callsOf("typeText").map((call) => call.text)).toEqual(["new@x.co"]);
		expect(doc(h.c).result).toMatchObject({ action: "fill", verified: true, characters: 8 });
		expect(h.steps[0]?.args).toEqual({ text: "new@x.co" });
	});

	test("a driver with select-all types over the selection: no Backspace at all", async () => {
		let typed = "";
		const h = harness([typingScreen("a@b.co")], {
			selectAll: true,
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
		expect(methods).toEqual(["tap", "selectAll", "typeText", "close"]);
		expect(h.driver.callsOf("key")).toEqual([]);
		expect(doc(h.c).result).toMatchObject({ action: "fill", verified: true });
	});

	test("a field that shows its placeholder as the value is typed into with no clearing keys", async () => {
		let typed = "";
		let focused = false;
		const placeholderScreen = (value: string) =>
			snapshotOf([
				el("window", {
					children: [
						el("textfield", { label: "Email", id: "email", value: value || "Email", placeholder: "Email", focused }),
					],
				}),
			]);
		const h = harness([placeholderScreen("")], {
			selectAll: true,
			onCall: (call, driver) => {
				if (call.method === "tap") {
					focused = true;
					driver.set(placeholderScreen(typed));
				}
				if (call.method === "typeText") {
					typed += call.text;
					driver.set(placeholderScreen(typed));
				}
				return undefined;
			},
		});
		expect(await h.run("fill", "id=email", "new@x.co", "--json")).toBe(0);
		expect(h.driver.callsOf("key")).toEqual([]);
		expect(h.driver.callsOf("selectAll")).toEqual([]);
		expect(doc(h.c).result).toMatchObject({ verified: true });
		// one hit-test sees the field take focus after the tap, two confirm the text
		expect(h.driver.callsOf("elementAtPoint")).toHaveLength(3);
	});

	test("the retry after a field did not take the text backspaces per character, not by select-all", async () => {
		const h = harness([typingScreen("old")], { selectAll: true });
		expect(await h.run("fill", "id=email", "new", "--json")).toBe(1);
		const methods: string[] = h.driver.calls
			.map((call) => call.method)
			.filter((m) => m !== "snapshot" && m !== "elementAtPoint");
		expect(methods).toEqual([
			"tap",
			"selectAll",
			"typeText",
			"tap",
			...Array.from({ length: 4 }, () => "key"),
			"typeText",
			"close",
		]);
	});

	test("a field that does not take the text: retried once, then failed with what it holds", async () => {
		const h = harness([typingScreen("old")]);
		expect(await h.run("fill", "id=email", "new", "--json")).toBe(1);
		const out = doc(h.c);
		expect(out.error.code).toBe("failed");
		expect(out.error.message).toBe('fill did not take: expected "new" but the field holds "old"');
		expect(h.driver.callsOf("typeText").map((call) => call.text)).toEqual(["new", "new"]);
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

describe("fill on a driver with pasteText (iOS)", () => {
	/** a filled email field; a paste or typed text leaves the field showing what it was given */
	function pasteHarness(onPaste?: (text: string) => string | undefined) {
		let typed = "";
		return harness([typingScreen("a@b.co")], {
			selectAll: true,
			pasteText: true,
			onCall: (call, driver) => {
				if (call.method === "pasteText") {
					const refused = onPaste?.(call.text);
					if (refused === "fail") return failWith("E_IO", "pasteboard write not confirmed");
					typed = call.text;
					driver.set(typingScreen(typed));
				}
				if (call.method === "typeText") {
					typed += call.text;
					driver.set(typingScreen(typed));
				}
				return undefined;
			},
		});
	}
	const inputs = (h: ReturnType<typeof pasteHarness>): string[] =>
		h.driver.calls.map((call) => call.method).filter((m) => m !== "snapshot" && m !== "elementAtPoint");

	test("pastes over the select-all by default and the read-back confirms", async () => {
		const h = pasteHarness();
		expect(await h.run("fill", "id=email", "new@x.co", "--json")).toBe(0);
		expect(inputs(h)).toEqual(["tap", "selectAll", "pasteText", "close"]);
		expect(doc(h.c).result).toMatchObject({ action: "fill", verified: true, characters: 8 });
		expect(h.steps[0]?.args).toEqual({ text: "new@x.co" });
	});

	test("--via type types and is recorded", async () => {
		const h = pasteHarness();
		expect(await h.run("fill", "id=email", "new@x.co", "--via", "type", "--json")).toBe(0);
		expect(inputs(h)).toEqual(["tap", "selectAll", "typeText", "close"]);
		expect(h.steps[0]?.args).toEqual({ text: "new@x.co", via: "type" });
	});

	test("--via paste is the default and not recorded", async () => {
		const h = pasteHarness();
		expect(await h.run("fill", "id=email", "new@x.co", "--via", "paste", "--json")).toBe(0);
		expect(h.driver.callsOf("pasteText")).toHaveLength(1);
		expect(h.steps[0]?.args).toEqual({ text: "new@x.co" });
	});

	test("a paste that fails is typed in the same attempt", async () => {
		const h = pasteHarness(() => "fail");
		expect(await h.run("fill", "id=email", "new@x.co", "--json")).toBe(0);
		expect(inputs(h)).toEqual(["tap", "selectAll", "pasteText", "typeText", "close"]);
	});

	test("a paste the field mangles is retried by typing", async () => {
		let pastes = 0;
		const h = harness([typingScreen("a@b.co")], {
			selectAll: true,
			pasteText: true,
			onCall: (call, driver) => {
				if (call.method === "pasteText") {
					pastes += 1;
					driver.set(typingScreen(call.text.slice(0, 3)));
				}
				if (call.method === "key") driver.set(typingScreen(""));
				if (call.method === "typeText") driver.set(typingScreen(call.text));
				return undefined;
			},
		});
		expect(await h.run("fill", "id=email", "new@x.co", "--json")).toBe(0);
		expect(pastes).toBe(1);
		expect(h.driver.callsOf("typeText").map((call) => call.text)).toEqual(["new@x.co"]);
	});

	test("an unknown --via is a usage error", async () => {
		const h = pasteHarness();
		expect(await h.run("fill", "id=email", "x", "--via", "clipboard", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
		expect(h.driver.callsOf("tap")).toEqual([]);
	});

	test("--secure pastes and records no text", async () => {
		const h = harness([typingScreen("")], { pasteText: true });
		expect(await h.run("fill", "id=email", "hunter2hunter2", "--secure", "--json")).toBe(0);
		expect(h.driver.callsOf("pasteText").map((call) => call.text)).toEqual(["hunter2hunter2"]);
		expect(h.steps[0]?.args).toEqual({ secure: true });
		expect(h.c.stdout[0]).not.toContain("hunter2");
	});
});

describe("fill on a driver with setText (Android warden-uiad)", () => {
	/** a filled email field; `setText` and `typeText` both leave the field showing what they were given */
	function setTextHarness(optIn: boolean) {
		let typed = "";
		const h = harness([typingScreen("a@b.co")], {
			selectAll: true,
			setText: true,
			onCall: (call, driver) => {
				if (call.method === "setText") driver.set(typingScreen(call.text));
				if (call.method === "typeText") {
					typed += call.text;
					driver.set(typingScreen(typed));
				}
				return undefined;
			},
		});
		if (optIn) h.c.env = { ...h.c.env, WARDEN_ANDROID_SETTEXT: "1" };
		return h;
	}
	const inputs = (h: ReturnType<typeof setTextHarness>): string[] =>
		h.driver.calls.map((call) => call.method).filter((m) => m !== "snapshot" && m !== "elementAtPoint");

	test("without the opt-in the field is selected and typed over, never set", async () => {
		const h = setTextHarness(false);
		expect(await h.run("fill", "id=email", "new@x.co", "--json")).toBe(0);
		expect(inputs(h)).toEqual(["tap", "selectAll", "typeText", "close"]);
		expect(doc(h.c).result).toMatchObject({ action: "fill", verified: true });
	});

	test("WARDEN_ANDROID_SETTEXT=1: one setText after the focus tap, then the read-back confirms it", async () => {
		const h = setTextHarness(true);
		expect(await h.run("fill", "id=email", "new@x.co", "--json")).toBe(0);
		expect(inputs(h)).toEqual(["tap", "setText", "close"]);
		expect(h.driver.callsOf("setText").map((call) => call.text)).toEqual(["new@x.co"]);
		expect(h.driver.callsOf("elementAtPoint").length).toBeGreaterThan(0);
		expect(doc(h.c).result).toMatchObject({ action: "fill", verified: true, characters: 8 });
	});

	test("WARDEN_ANDROID_SETTEXT=1 with a setText that did not take: the counted retry types", async () => {
		const h = setTextHarness(true);
		h.driver.setText = async (text) => {
			h.driver.calls.push({ method: "setText", text });
			return { success: true, data: undefined };
		};
		expect(await h.run("fill", "id=email", "new", "--json")).toBe(0);
		expect(h.driver.callsOf("setText")).toHaveLength(1);
		expect(h.driver.callsOf("typeText").map((call) => call.text)).toEqual(["new"]);
		expect(doc(h.c).result).toMatchObject({ verified: true });
	});

	test("WARDEN_ANDROID_SETTEXT=1 --no-verify: set without a read-back", async () => {
		const h = setTextHarness(true);
		expect(await h.run("fill", "id=email", "x", "--no-verify", "--json")).toBe(0);
		expect(inputs(h)).toEqual(["tap", "setText", "close"]);
		expect(h.driver.callsOf("elementAtPoint")).toEqual([]);
		expect(doc(h.c).result.verified).toBeUndefined();
	});

	test("WARDEN_ANDROID_SETTEXT=1 --secure: set, unconfirmed, the text neither echoed nor recorded", async () => {
		const h = setTextHarness(true);
		expect(await h.run("fill", "id=email", "hunter2hunter2", "--secure", "--json")).toBe(0);
		expect(h.driver.callsOf("setText").map((call) => call.text)).toEqual(["hunter2hunter2"]);
		expect(h.driver.callsOf("elementAtPoint")).toEqual([]);
		expect(doc(h.c).result).toMatchObject({ verified: "unconfirmed", secure: true, characters: 14 });
		expect(h.c.stdout.join("\n")).not.toContain("hunter2");
		expect(h.steps[0]?.args).toEqual({ secure: true });
	});

	test("WARDEN_ANDROID_SETTEXT=1 with an x y target: nothing known to clear, so it is typed into", async () => {
		const h = setTextHarness(true);
		expect(await h.run("fill", "50", "60", "abc", "--json")).toBe(0);
		expect(h.driver.callsOf("setText")).toEqual([]);
		expect(h.driver.callsOf("typeText").map((call) => call.text)).toEqual(["abc"]);
	});
});

describe("type / key", () => {
	test("type --submit types then presses Enter", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("type", "hello", "--submit", "--json")).toBe(0);
		expect(h.driver.calls.filter((call) => call.method === "typeText" || call.method === "key")).toEqual([
			{ method: "typeText", text: "hello" },
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
		expect(await h.run("gesture", "swipe", "up")).toBe(0);
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
		await h.run("gesture", "swipe", "up");
		await h.run("scroll", "down");
		const [finger, content] = h.driver.callsOf("swipe");
		expect(finger).toMatchObject({ from: content?.from, to: content?.to });
	});

	test("x1 y1 x2 y2 is used as given", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("gesture", "swipe", "10", "20", "30", "40")).toBe(0);
		expect(h.driver.callsOf("swipe")[0]).toMatchObject({ from: { x: 10, y: 20 }, to: { x: 30, y: 40 } });
	});

	test("--from swipes inside that element", async () => {
		const list = snapshotOf([
			el("window", { children: [el("list", { id: "list", frame: { x: 20, y: 100, width: 350, height: 400 } })] }),
		]);
		const h = harness([list]);
		expect(await h.run("gesture", "swipe", "left", "--from", "id=list")).toBe(0);
		expect(h.driver.callsOf("swipe")[0]).toMatchObject({
			from: { x: 195 + 87.5, y: 300 },
			to: { x: 195 - 87.5, y: 300 },
		});
	});

	test("nonsense: usage error", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("gesture", "swipe", "sideways", "--json")).toBe(1);
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

	test("without --relaunch an already running app is attached to, and the output says so", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		await h.driver.app.launch("com.example.app");
		expect(await h.run("open", "com.example.app", "--json")).toBe(0);
		expect(doc(h.c).result).toMatchObject({
			action: "open",
			bundleId: "com.example.app",
			relaunch: false,
			attached: true,
		});
		expect(h.driver.callsOf("app.launch")[1]?.opts).toEqual({ relaunch: false });
		const text = harness([snapshotOf(LOGIN)]);
		await text.driver.app.launch("com.example.app");
		expect(await text.run("open", "com.example.app")).toBe(0);
		expect(text.c.stdout.join("\n")).toContain("attached to com.example.app");
	});

	test("--relaunch never reports attached, and a first launch is not attached", async () => {
		const first = harness([snapshotOf(LOGIN)]);
		await first.run("open", "com.example.app", "--json");
		expect(doc(first.c).result.attached).toBe(false);
		const again = harness([snapshotOf(LOGIN)]);
		await again.driver.app.launch("com.example.app");
		await again.run("open", "com.example.app", "--relaunch", "--json");
		expect(doc(again.c).result).toMatchObject({ relaunch: true, attached: false });
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
		expect(await h.run("screen", "rotate", "landscape-left", "--json")).toBe(0);
		expect(h.driver.callsOf("orientation")).toEqual([{ method: "orientation", set: "landscapeLeft" }]);
		expect(doc(h.c).result.orientation).toBe("landscapeLeft");
		expect(await h.run("screen", "rotate", "--json")).toBe(0);
		expect(doc(h.c).result.orientation).toBe("landscapeLeft");
		expect(await h.run("screen", "rotate", "sideways", "--json")).toBe(1);
	});

	test("appearance sets (and reads) light / dark", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("screen", "appearance", "dark", "--json")).toBe(0);
		expect(h.driver.callsOf("appearance")).toEqual([{ method: "appearance", set: "dark" }]);
		expect(await h.run("screen", "appearance", "--json")).toBe(0);
		expect(doc(h.c).result.appearance).toBe("dark");
		expect(await h.run("screen", "appearance", "blue", "--json")).toBe(1);
	});

	test("screenshot numbers its files under $WARDEN_HOME/ui/<udid>/shots, or goes where told", async () => {
		const h = harness([snapshotOf(LOGIN)], {
			onCall: (call) => {
				if (call.method === "screenshot" && call.opts?.path) writeFileSync(call.opts.path, "png");
				return undefined;
			},
		});
		await h.run("screen", "screenshot", "--json");
		const first: string = doc(h.c).result.path;
		expect(first).toMatch(new RegExp(`/ui/${UDID}/shots/001\\.png$`));
		expect(h.driver.callsOf("screenshot")[0]?.opts?.path).toBe(first);
		await h.run("screen", "screenshot", "--json");
		expect(doc(h.c).result.path).toMatch(/\/shots\/002\.png$/);
		await h.run("screen", "screenshot", "out/shot.png", "--json");
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
		expect(await h.run("screen", "video", "start", "--json")).toBe(0);
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

		expect(await h.run("screen", "video", "start", "--json")).toBe(1);
		expect(doc(h.c).error.message).toContain("already recording");

		expect(await h.run("screen", "video", "stop", "--json")).toBe(0);
		expect(fake.signals).toEqual(["SIGINT"]);
		expect(doc(h.c).result).toEqual({ action: "video", state: "stopped", path });
		expect(readState(h.c, UDID).video).toBeUndefined();
		expect(await h.run("screen", "video", "stop", "--json")).toBe(1);
	});

	test("a record another call writes while stop waits on the recorder survives the stop (14-6)", async () => {
		const fake = fakeVideo();
		const h = harness([snapshotOf(LOGIN)], { video: fake.video });
		const kill = fake.video.kill;
		fake.video.kill = (pid, signal) => {
			kill(pid, signal);
			updateState(h.c, UDID, (state) => ({ ...state, collector: { pid: 5151, startedAt: 1 } }));
		};
		await h.run("screen", "video", "start");
		expect(await h.run("screen", "video", "stop", "--json")).toBe(0);
		expect(readState(h.c, UDID).video).toBeUndefined();
		expect(readState(h.c, UDID).collector).toEqual({ pid: 5151, startedAt: 1 });
	});

	test("a recorder pid now running another program is never signalled: stop forgets it, start records anew (14-4)", async () => {
		const fake = fakeVideo();
		const h = harness([snapshotOf(LOGIN)], { video: fake.video });
		await h.run("screen", "video", "start");
		fake.video.command = () => "/usr/bin/vim notes.txt";
		expect(await h.run("screen", "video", "start", "--json")).toBe(0);
		expect(fake.specs).toHaveLength(2);
		expect(await h.run("screen", "video", "stop", "--json")).toBe(0);
		expect(fake.signals).toEqual([]);
		expect(doc(h.c).warnings?.[0]).toContain("had already ended");
		expect(readState(h.c, UDID).video).toBeUndefined();
	});

	test("a live recorder whose command line cannot be read is not signalled and stays recorded, with a warning", async () => {
		const fake = fakeVideo();
		const h = harness([snapshotOf(LOGIN)], { video: fake.video });
		await h.run("screen", "video", "start");
		const recorded = readState(h.c, UDID).video;
		fake.video.command = () => undefined;
		expect(await h.run("screen", "video", "stop", "--json")).toBe(0);
		expect(fake.signals).toEqual([]);
		expect(doc(h.c).result).toMatchObject({ action: "video", state: "recording", pid: 4242 });
		expect(doc(h.c).warnings?.[0]).toContain("could not stop the recorder (pid 4242)");
		expect(readState(h.c, UDID).video).toEqual(recorded);
	});

	test("the recorder is signalled while its command line is still this device's recordVideo into the file", async () => {
		const fake = fakeVideo();
		const h = harness([snapshotOf(LOGIN)], { video: fake.video });
		fake.video.command = () => fake.specs.at(-1)?.argv.join(" ");
		await h.run("screen", "video", "start");
		expect(await h.run("screen", "video", "stop", "--json")).toBe(0);
		expect(fake.signals).toEqual(["SIGINT"]);
		expect(doc(h.c).warnings ?? []).toEqual([]);
	});

	test("a recorder that ignores SIGINT is killed with a warning", async () => {
		const fake = fakeVideo();
		fake.video.kill = (_pid, signal) => {
			fake.signals.push(signal);
			if (signal === "SIGKILL") return;
		};
		const h = harness([snapshotOf(LOGIN)], { video: fake.video });
		await h.run("screen", "video", "start");
		expect(await h.run("screen", "video", "stop", "--json")).toBe(0);
		expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
		expect(doc(h.c).warnings?.[0]).toContain("ignored SIGINT");
	});
});
