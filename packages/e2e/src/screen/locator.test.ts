import { describe, expect, test } from "bun:test";
import { el, type FakeDriver, fakeDriver, snapshotOf } from "../driver/driver.testing";
import { KEY_PACE_MS } from "../driver/typing";
import { E2eError } from "../errors";
import { CONFIRM_READS, FIELD_POLL_MS, STALE_RISK_READS } from "./field";
import { createScreen } from "./screen";
import { FIELD_FRAME, fieldFixture, staticDriver, testHost } from "./screen.testing";

async function failure(promise: Promise<unknown>): Promise<E2eError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof E2eError) return error;
		throw error;
	}
	throw new Error("did not reject");
}

/** Everything the driver was asked to type, concatenated. */
function typed(driver: FakeDriver): string {
	return driver
		.callsOf("typeText")
		.map((call) => call.text)
		.join("");
}

function login() {
	return staticDriver([
		el("text", { id: "title", label: "Welcome" }),
		el("textfield", { id: "email", label: "Email", value: "me@x.co" }),
		el("button", { id: "submit", label: "Sign in", hittable: true }),
		el("button", { id: "later", label: "Later", enabled: false }),
		el("switch", { id: "remember", label: "Remember me", value: "1" }),
		el("other", { id: "card", children: [el("text", { label: "Invoice 42" }), el("text", { label: "$10" })] }),
		el("other", { id: "card2", children: [el("text", { label: "Invoice 43" })] }),
	]);
}

function setup(driver = login(), options: Parameters<typeof testHost>[1] = {}) {
	const host = testHost(driver, options);
	return { driver, host, screen: createScreen(host) };
}

describe("tap", () => {
	test("taps the centre of the single match", async () => {
		const { driver, screen } = setup();
		await screen.getByTestId("submit").tap();
		expect(driver.callsOf("tap")).toEqual([{ method: "tap", point: { x: 195, y: 122 } }]);
	});

	test("the driver's tap point wins and position is an offset from the corner", async () => {
		const withPoint = setup(staticDriver([el("button", { id: "b", tapPoint: { x: 7, y: 8 } })]));
		await withPoint.screen.getByTestId("b").tap();
		expect(withPoint.driver.callsOf("tap")[0]?.point).toEqual({ x: 7, y: 8 });
		const { driver, screen } = setup();
		await screen.getByTestId("submit").tap({ position: { x: 10, y: 5 } });
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 10, y: 105 });
	});

	test("is reported as a step named after the locator", async () => {
		const { host, screen } = setup();
		await screen.getByTestId("submit").tap();
		expect(host.steps).toEqual(['tap getByTestId("submit")']);
	});

	test("works without a step reporter", async () => {
		const { driver, screen } = setup(login(), { withSteps: false });
		await screen.getByTestId("submit").tap();
		expect(driver.callsOf("tap")).toHaveLength(1);
	});

	test("waits for the element to appear, polling every 100 ms", async () => {
		let snapshots = 0;
		const driver = fakeDriver({
			screens: () => (snapshots++ < 2 ? snapshotOf([]) : snapshotOf([el("button", { id: "submit" })])),
		});
		const { host, screen } = setup(driver);
		await screen.getByTestId("submit").tap();
		expect(host.clock.sleeps).toEqual([100, 100]);
		expect(driver.callsOf("tap")).toHaveLength(1);
	});

	test("never appearing is LOCATOR_NOT_FOUND after the action timeout, with the screen attached", async () => {
		const { host, screen } = setup();
		const error = await failure(screen.getByTestId("nope").tap());
		expect(error.code).toBe("LOCATOR_NOT_FOUND");
		expect(error.message).toContain('getByTestId("nope")');
		expect(error.screen).toContain("# ios axbridge");
		expect(error.screen).toContain("id=submit");
		expect(host.clock.elapsed()).toBe(1000);
	});

	test("a per-call timeout replaces the action timeout", async () => {
		const { host, screen } = setup();
		await failure(screen.getByTestId("nope").tap({ timeout: 300 }));
		expect(host.clock.elapsed()).toBe(300);
	});

	test("a host action timeout override is honoured", async () => {
		const { host, screen } = setup(login());
		host.actionTimeout = () => 250;
		await failure(screen.getByTestId("nope").tap());
		expect(host.clock.elapsed()).toBe(250);
	});

	test("a disabled element is NOT_ACTIONABLE after the timeout", async () => {
		const { host, driver, screen } = setup();
		const error = await failure(screen.getByTestId("later").tap());
		expect(error.code).toBe("NOT_ACTIONABLE");
		expect(error.message).toContain("disabled");
		expect(error.screen).toContain("[button]");
		expect(host.clock.elapsed()).toBe(1000);
		expect(driver.callsOf("tap")).toEqual([]);
	});

	test("a hidden element or one with no box on screen is NOT_ACTIONABLE (not visible)", async () => {
		const hidden = setup(staticDriver([el("button", { id: "x", hidden: true })]));
		expect((await failure(hidden.screen.getByTestId("x").tap())).message).toContain("not visible");
		const away = setup(staticDriver([el("button", { id: "x", frame: { x: 0, y: 900, width: 100, height: 40 } })]));
		expect((await failure(away.screen.getByTestId("x").tap())).code).toBe("NOT_ACTIONABLE");
	});

	test("a tap point outside the screen asks to scroll", async () => {
		const edge = setup(staticDriver([el("button", { id: "x", frame: { x: 0, y: 800, width: 100, height: 100 } })]));
		const error = await failure(edge.screen.getByTestId("x").tap());
		expect(error.code).toBe("NOT_ACTIONABLE");
		expect(error.message).toContain("scrollTo");
	});

	test("several matches fail at once with LOCATOR_AMBIGUOUS and the count", async () => {
		const { host, driver, screen } = setup(
			staticDriver([el("button", { label: "Void" }), el("button", { label: "Void" }), el("button", { label: "Keep" })])
		);
		const error = await failure(screen.getByRole("button", "Void").tap());
		expect(error.code).toBe("LOCATOR_AMBIGUOUS");
		expect(error.matches).toBe(2);
		expect(error.message).toContain("2 elements");
		expect(host.clock.sleeps).toEqual([]);
		expect(driver.callsOf("tap")).toEqual([]);
	});

	test("a retryable driver failure is retried, a fatal one is thrown", async () => {
		let calls = 0;
		const flaky = fakeDriver({
			screens: [snapshotOf([el("button", { id: "b" })])],
			onCall: (call) =>
				call.method === "snapshot" && calls++ < 2
					? { error: { code: "E_AX_UNAVAILABLE", message: "busy", retryable: true } }
					: undefined,
		});
		const first = setup(flaky);
		await first.screen.getByTestId("b").tap();
		expect(first.host.clock.sleeps).toEqual([100, 100]);

		const broken = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (call) =>
				call.method === "snapshot"
					? { error: { code: "E_HELPER_CRASHED", message: "gone", retryable: false } }
					: undefined,
		});
		const error = await failure(setup(broken).screen.getByTestId("b").tap());
		expect(error.code).toBe("DRIVER");
		expect(error.message).toContain("E_HELPER_CRASHED");
	});

	test("a failing driver tap is ACTION_FAILED", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([el("button", { id: "b" })])],
			onCall: (call) =>
				call.method === "tap" ? { error: { code: "E_HID", message: "no hid", retryable: false } } : undefined,
		});
		const error = await failure(setup(driver).screen.getByTestId("b").tap());
		expect(error.code).toBe("ACTION_FAILED");
		expect(error.message).toContain("E_HID");
	});

	test("an aborted attempt stops the wait with its own error", async () => {
		const { host, screen } = setup();
		const controller = new AbortController();
		controller.abort(new E2eError("TIMEOUT", "test timed out after 5s"));
		host.signal = controller.signal;
		const error = await failure(screen.getByTestId("nope").tap());
		expect(error.code).toBe("TIMEOUT");
		expect(error.message).toBe("test timed out after 5s");
	});
});

describe("longPress", () => {
	test("long-presses the centre, forwarding the duration", async () => {
		const { driver, screen } = setup();
		await screen.getByTestId("submit").longPress({ durationMs: 800 });
		expect(driver.callsOf("longPress")).toEqual([
			{ method: "longPress", point: { x: 195, y: 122 }, opts: { durationMs: 800 } },
		]);
	});

	test("without options the driver default applies", async () => {
		const { driver, screen } = setup();
		await screen.getByTestId("submit").longPress();
		expect(driver.callsOf("longPress")).toEqual([{ method: "longPress", point: { x: 195, y: 122 } }]);
	});
});

describe("fill", () => {
	test("focuses at the right end, types, then verifies the value", async () => {
		const { driver, state } = fieldFixture();
		const { host, screen } = setup(driver);
		await screen.getByTestId("field").fill("ada@example.test");
		expect(state.value).toBe("ada@example.test");
		expect(driver.callsOf("tap")).toEqual([{ method: "tap", point: { x: 24 + 300 * 0.9, y: 222 } }]);
		expect(driver.callsOf("key")).toEqual([]);
		expect(typed(driver)).toBe("ada@example.test");
		expect(driver.calls.at(-1)?.method).toBe("elementAtPoint");
		expect(host.steps).toEqual(['fill getByTestId("field")']);
	});

	test("empties existing content first: one backspace per character plus a spare", async () => {
		const { driver, state } = fieldFixture({ value: "abc" });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("new");
		expect(driver.callsOf("key")).toHaveLength(4);
		expect(driver.callsOf("key").every((call) => call.key === "Backspace")).toBe(true);
		expect(state.value).toBe("new");
	});

	test("retries once when the value did not take", async () => {
		const { driver, state } = fieldFixture({ dropTypes: 1 });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("hello");
		expect(typed(driver)).toBe("hellohello");
		expect(driver.callsOf("tap")).toHaveLength(2);
		expect(state.value).toBe("hello");
	});

	test("gives up after the retry with ACTION_FAILED saying what the field holds", async () => {
		const { driver } = fieldFixture({ dropTypes: 10, value: "old" });
		const { screen } = setup(driver);
		const error = await failure(screen.getByTestId("field").fill("hello"));
		expect(error.code).toBe("ACTION_FAILED");
		expect(error.message).toContain('expected "hello"');
		expect(error.message).toContain('holds ""');
		expect(typed(driver)).toBe("hellohello");
	});

	test("a value that lags the keys is waited for, not retyped", async () => {
		const { driver, state } = fieldFixture({ lagReads: 3 });
		const { host, screen } = setup(driver);
		await screen.getByTestId("field").fill("hello");
		expect(state.value).toBe("hello");
		expect(typed(driver)).toBe("hello");
		expect(driver.callsOf("tap")).toHaveLength(1);
		expect(host.clock.sleeps.filter((ms) => ms === FIELD_POLL_MS).length).toBeGreaterThanOrEqual(4);
	});

	test("a dropped last character is retried once with a clear and a retype", async () => {
		const { driver, state } = fieldFixture({ dropTail: 1 });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("hello");
		expect(state.value).toBe("hello");
		expect(typed(driver)).toBe("hellohello");
		expect(driver.callsOf("tap")).toHaveLength(2);
		expect(driver.callsOf("key")).toHaveLength(5);
	});

	test("both attempts failing is ACTION_FAILED naming the expected text and what each attempt held", async () => {
		const { driver } = fieldFixture({ dropTail: 2, dropTailCalls: 2 });
		const { screen } = setup(driver);
		const error = await failure(screen.getByTestId("field").fill("hello"));
		expect(error.code).toBe("ACTION_FAILED");
		expect(error.message).toBe(
			'getByTestId("field"): fill did not take: expected "hello" but the field holds "hel" (first attempt held "hel")'
		);
		expect(error.screen).toBeUndefined();
	});

	test("a stale read of the old value is not trusted when it equals the wanted text", async () => {
		const { driver, state } = fieldFixture({ value: "hello", lagReads: 2, dropTail: 1 });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("hello");
		expect(state.value).toBe("hello");
		expect(typed(driver)).toBe("hellohello");
		expect(driver.callsOf("tap")).toHaveLength(2);
	});

	test("a filled field is replaced by typing over a select-all: no Backspace at all", async () => {
		const { driver, state } = fieldFixture({ value: "ada@example.test", selectAll: true });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("grace@example.test");
		expect(
			driver.calls.map((call) => call.method).filter((method) => method === "selectAll" || method === "key")
		).toEqual(["selectAll"]);
		expect(driver.callsOf("key")).toEqual([]);
		expect(state.value).toBe("grace@example.test");
	});

	test("on a driver with setText a filled field is replaced in one call and still read back", async () => {
		const { driver, state } = fieldFixture({ value: "ada@example.test", selectAll: true, setText: true });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("grace@example.test");
		expect(driver.callsOf("setText").map((call) => call.text)).toEqual(["grace@example.test"]);
		expect(driver.callsOf("selectAll")).toEqual([]);
		expect(driver.callsOf("typeText")).toEqual([]);
		expect(state.value).toBe("grace@example.test");
	});

	test("a setText that did not take is caught by the read-back and retyped the counted way", async () => {
		const { driver, state } = fieldFixture({ value: "ada", setText: true });
		driver.setText = async (text) => {
			driver.calls.push({ method: "setText", text });
			return { success: true, data: undefined };
		};
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("grace");
		expect(driver.callsOf("setText")).toHaveLength(1);
		expect(driver.callsOf("typeText").map((call) => call.text)).toEqual(["grace"]);
		expect(state.value).toBe("grace");
	});

	test("an empty field that shows its placeholder as the value sends no clearing keys", async () => {
		const { driver, state } = fieldFixture({ placeholder: "ada@example.test", selectAll: true });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("grace@example.test");
		expect(driver.callsOf("key")).toEqual([]);
		expect(driver.callsOf("selectAll")).toEqual([]);
		expect(state.value).toBe("grace@example.test");
	});

	test("iOS reports no placeholder, so such a field is typed over a select-all, never backspaced per placeholder character", async () => {
		const { driver, state } = fieldFixture({ placeholder: "ada@example.com", placeholderMeta: false, selectAll: true });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("grace@example.com");
		expect(driver.callsOf("selectAll")).toHaveLength(1);
		expect(driver.callsOf("key")).toEqual([]);
		expect(state.value).toBe("grace@example.com");
	});

	test("a secure field showing its placeholder is typed into with no clearing keys", async () => {
		const { driver, state } = fieldFixture({ secure: true, placeholder: "At least 8 characters", selectAll: true });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("password1");
		expect(driver.callsOf("key")).toEqual([]);
		expect(driver.callsOf("selectAll")).toEqual([]);
		expect(state.value).toBe("password1");
	});

	test("a field that refuses select-all is retried with counted Backspaces (one per character of what it now holds) and a retype", async () => {
		const { driver, state } = fieldFixture({ value: "old", selectAllRefused: true });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("new");
		expect(state.value).toBe("new");
		expect(driver.callsOf("selectAll")).toHaveLength(1);
		const keys = driver.callsOf("key");
		expect(keys.every((call) => call.key === "Backspace")).toBe(true);
		expect(keys).toHaveLength("oldnew".length + 1);
		expect(typed(driver)).toBe("newnew");
		expect(driver.callsOf("tap")).toHaveLength(2);
	});

	test("a typeText lost after the select-all leaves the field empty and the retry types it again without clearing keys", async () => {
		const { driver, state } = fieldFixture({ value: "old", selectAll: true, dropTypes: 1 });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("new");
		expect(state.value).toBe("new");
		expect(driver.callsOf("selectAll")).toHaveLength(1);
		expect(driver.callsOf("key")).toEqual([]);
		expect(driver.callsOf("typeText")).toHaveLength(2);
		expect(driver.callsOf("tap")).toHaveLength(2);
	});

	test("a select-all that selected only part of the text is caught by the confirm and retried with counted Backspaces", async () => {
		let value = "old";
		const driver = fakeDriver({
			screens: () =>
				snapshotOf([
					el("textfield", { id: "field", label: "Email", value, frame: { x: 24, y: 200, width: 300, height: 44 } }),
				]),
			selectAll: true,
			onCall: (call) => {
				if (call.method === "typeText") value += call.text;
				else if (call.method === "key" && call.key === "Backspace") value = value.slice(0, -1);
				return undefined;
			},
		});
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("new");
		expect(value).toBe("new");
		expect(driver.callsOf("selectAll")).toHaveLength(1);
		expect(driver.callsOf("key").length).toBeGreaterThanOrEqual(6);
		expect(driver.callsOf("tap")).toHaveLength(2);
	});

	test("without select-all the counted Backspaces still empty the field", async () => {
		const { driver, state } = fieldFixture({ value: "old" });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("new");
		expect(driver.callsOf("selectAll")).toEqual([]);
		expect(driver.callsOf("key")).toHaveLength(4);
		expect(state.value).toBe("new");
	});

	test("typed text equal to the placeholder is confirmed on two reads, not four", async () => {
		const { driver, state } = fieldFixture({ placeholder: "ada@example.test", selectAll: true });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("ada@example.test");
		expect(state.value).toBe("ada@example.test");
		expect(driver.callsOf("elementAtPoint")).toHaveLength(CONFIRM_READS);
	});

	test("a field that already held the wanted text still needs the longer run of reads", async () => {
		const { driver } = fieldFixture({ value: "ada@example.test", selectAll: true });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("ada@example.test");
		expect(driver.callsOf("elementAtPoint")).toHaveLength(STALE_RISK_READS);
	});

	test("a value still changing keeps the wait going past the usual window", async () => {
		let value = "";
		let shown = 0;
		const driver = fakeDriver({
			screens: () => {
				shown = Math.min(value.length, shown + 1);
				return snapshotOf([el("textfield", { id: "field", value: value.slice(0, shown), frame: FIELD_FRAME })]);
			},
			onCall: (call) => {
				if (call.method === "typeText") value += call.text;
				return undefined;
			},
		});
		const { host, screen } = setup(driver, { actionTimeoutMs: 5000 });
		await screen.getByTestId("field").fill("abcdefghijklmnopqrstuvwxyz0123");
		expect(typed(driver)).toBe("abcdefghijklmnopqrstuvwxyz0123");
		expect(driver.callsOf("tap")).toHaveLength(1);
		expect(host.clock.elapsed()).toBeGreaterThan(1400);
	});

	test("reads the field with a hit-test, not a snapshot, once the field is typed into", async () => {
		const { driver } = fieldFixture();
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("hi");
		expect(driver.callsOf("snapshot")).toHaveLength(1);
		expect(driver.callsOf("elementAtPoint").length).toBeGreaterThanOrEqual(2);
		expect(driver.callsOf("elementAtPoint")[0]?.point).toEqual({ x: 174, y: 222 });
	});

	test("iOS types the whole string in one request, with no client pacing", async () => {
		const { driver } = fieldFixture();
		const { host, screen } = setup(driver);
		await screen.getByTestId("field").fill("abc");
		expect(driver.callsOf("typeText").map((call) => call.text)).toEqual(["abc"]);
		expect(host.clock.sleeps.filter((ms) => ms === KEY_PACE_MS)).toHaveLength(0);
	});

	test("secure fields are not verified", async () => {
		const { driver } = fieldFixture({ secure: true, dropTypes: 5 });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("hunter2");
		expect(typed(driver)).toBe("hunter2");
		expect(driver.calls.at(-1)?.method).toBe("typeText");
	});

	test("an empty string only clears", async () => {
		const { driver, state } = fieldFixture({ value: "ab" });
		const { screen } = setup(driver);
		await screen.getByTestId("field").fill("");
		expect(driver.callsOf("typeText")).toEqual([]);
		expect(state.value).toBe("");
	});

	test("the typed text never appears in the step label", async () => {
		const { driver } = fieldFixture();
		const { host, screen } = setup(driver);
		await screen.getByTestId("field").fill("s3cret");
		expect(host.steps.join("\n")).not.toContain("s3cret");
	});

	test("a field that is disabled is NOT_ACTIONABLE", async () => {
		const { screen } = setup(staticDriver([el("textfield", { id: "field", enabled: false })]));
		expect((await failure(screen.getByTestId("field").fill("x"))).code).toBe("NOT_ACTIONABLE");
	});

	test("the driver refusing the text is ACTION_FAILED", async () => {
		const { driver } = fieldFixture();
		const refusing = fakeDriver({
			screens: () => driver.screen,
			onCall: (call) =>
				call.method === "typeText"
					? { error: { code: "E_UNSUPPORTED_TEXT", message: "ascii only", retryable: false } }
					: undefined,
		});
		const error = await failure(setup(refusing).screen.getByTestId("field").fill("héllo"));
		expect(error.code).toBe("ACTION_FAILED");
		expect(error.message).toContain("E_UNSUPPORTED_TEXT");
	});
});

describe("type, clear and press", () => {
	test("type focuses first when the field is not focused", async () => {
		const { driver, state } = fieldFixture({ value: "ab" });
		const { screen } = setup(driver);
		await screen.getByTestId("field").type("c");
		expect(
			driver.calls.filter((call) => call.method === "tap" || call.method === "typeText").map((call) => call.method)
		).toEqual(["tap", "typeText"]);
		expect(state.value).toBe("abc");
	});

	test("type does not tap a focused field", async () => {
		const { driver } = fieldFixture({ focused: true });
		const { screen } = setup(driver);
		await screen.getByTestId("field").type("x");
		expect(driver.callsOf("tap")).toEqual([]);
		expect(driver.callsOf("typeText")).toHaveLength(1);
	});

	test("clear empties the field", async () => {
		const { driver, state } = fieldFixture({ value: "ab" });
		const { screen } = setup(driver);
		await screen.getByTestId("field").clear();
		expect(state.value).toBe("");
		expect(driver.callsOf("key")).toHaveLength(3);
	});

	test("clear selects all and presses one Backspace when the driver can", async () => {
		const { driver, state } = fieldFixture({ value: "abcdef", selectAll: true });
		const { screen } = setup(driver);
		await screen.getByTestId("field").clear();
		expect(state.value).toBe("");
		expect(driver.callsOf("selectAll")).toHaveLength(1);
		expect(driver.callsOf("key")).toHaveLength(1);
	});

	test("clear on a field that refuses select-all is run again with counted Backspaces", async () => {
		const { driver, state } = fieldFixture({ value: "ab", selectAllRefused: true });
		const { screen } = setup(driver);
		await screen.getByTestId("field").clear();
		expect(state.value).toBe("");
		expect(driver.callsOf("selectAll")).toHaveLength(1);
		expect(driver.callsOf("key")).toHaveLength(1 + 2);
	});

	test("clear that leaves text behind is run once more, then fails with what the field holds", async () => {
		const retried = fieldFixture({ value: "ab", dropKeys: 3 });
		await setup(retried.driver).screen.getByTestId("field").clear();
		expect(retried.state.value).toBe("");
		const stuck = fieldFixture({ value: "ab", dropKeys: 100 });
		const error = await failure(setup(stuck.driver).screen.getByTestId("field").clear());
		expect(error.code).toBe("ACTION_FAILED");
		expect(error.message).toContain('clear did not empty the field: it holds "ab"');
	});

	test("type sends the whole string unpaced and does not verify", async () => {
		const { driver, state } = fieldFixture({ focused: true });
		const { host, screen } = setup(driver);
		await screen.getByTestId("field").type("xy");
		expect(state.value).toBe("xy");
		expect(host.clock.sleeps).toEqual([]);
		expect(driver.callsOf("elementAtPoint")).toEqual([]);
	});

	test("press sends one key, with modifiers, after focusing", async () => {
		const { driver } = fieldFixture();
		const { screen } = setup(driver);
		await screen.getByTestId("field").press("Enter");
		await screen.getByTestId("field").press("Tab", { modifiers: ["shift"] });
		expect(driver.callsOf("key")).toEqual([
			{ method: "key", key: "Enter" },
			{ method: "key", key: "Tab", modifiers: ["shift"] },
		]);
		expect(driver.callsOf("tap")).toHaveLength(2);
	});
});

describe("swipe and scrollTo", () => {
	test("swipes within the element in the direction the content scrolls", async () => {
		const { driver, screen } = setup(
			staticDriver([el("list", { id: "feed", frame: { x: 0, y: 100, width: 390, height: 400 } })])
		);
		await screen.getByTestId("feed").swipe({ direction: "down" });
		expect(driver.callsOf("swipe")).toEqual([
			{ method: "swipe", from: { x: 195, y: 400 }, to: { x: 195, y: 200 }, opts: { durationMs: 350, momentum: false } },
		]);
	});

	test("a path is not allowed on a locator", async () => {
		const { screen } = setup();
		// @ts-expect-error locators take a direction only
		const error = await failure(screen.getByTestId("submit").swipe({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }));
		expect(error.code).toBe("INVALID_ARGUMENT");
	});

	test("scrollTo scrolls the screen until the locator is on screen", async () => {
		let swipes = 0;
		const driver = fakeDriver({
			screens: () =>
				snapshotOf([el("button", { id: "far", frame: { x: 0, y: swipes >= 2 ? 300 : 1500, width: 390, height: 44 } })]),
			onCall: (call) => {
				if (call.method === "swipe") swipes += 1;
				return undefined;
			},
		});
		const { screen } = setup(driver);
		await screen.getByTestId("far").scrollTo();
		expect(swipes).toBe(2);
	});
});

describe("reads", () => {
	test("text is the name, falling back to the descendants' text", async () => {
		const { screen } = setup();
		expect(await screen.getByTestId("title").text()).toBe("Welcome");
		expect(await screen.getByTestId("card").text()).toBe("Invoice 42 $10");
	});

	test("value is the field value or empty", async () => {
		const { screen } = setup();
		expect(await screen.getByTestId("email").value()).toBe("me@x.co");
		expect(await screen.getByTestId("submit").value()).toBe("");
	});

	test("count, all and allTexts answer zero or many without failing", async () => {
		const { screen } = setup();
		const buttons = screen.getByRole("button");
		expect(await buttons.count()).toBe(2);
		expect(await buttons.allTexts()).toEqual(["Sign in", "Later"]);
		const all = await buttons.all();
		expect(all).toHaveLength(2);
		expect(await all[1]?.text()).toBe("Later");
		expect(await screen.getByTestId("nope").count()).toBe(0);
		expect(await screen.getByTestId("nope").all()).toEqual([]);
		expect(await screen.getByTestId("nope").allTexts()).toEqual([]);
	});

	test("isVisible / isHidden: absent is hidden, hidden flag is not visible, several is ambiguous", async () => {
		const { screen } = setup(
			staticDriver([
				el("button", { id: "a" }),
				el("button", { id: "h", hidden: true }),
				el("text", { label: "x" }),
				el("text", { label: "x" }),
			])
		);
		expect(await screen.getByTestId("a").isVisible()).toBe(true);
		expect(await screen.getByTestId("a").isHidden()).toBe(false);
		expect(await screen.getByTestId("h").isVisible()).toBe(false);
		expect(await screen.getByTestId("nope").isVisible()).toBe(false);
		expect(await screen.getByTestId("nope").isHidden()).toBe(true);
		expect((await failure(screen.getByText("x").isVisible())).code).toBe("LOCATOR_AMBIGUOUS");
	});

	test("isEnabled, isChecked, boundingBox", async () => {
		const { screen } = setup();
		expect(await screen.getByTestId("submit").isEnabled()).toBe(true);
		expect(await screen.getByTestId("later").isEnabled()).toBe(false);
		expect(await screen.getByTestId("remember").isChecked()).toBe(true);
		expect(await screen.getByTestId("submit").isChecked()).toBe(false);
		expect(await screen.getByTestId("submit").boundingBox()).toEqual({ x: 0, y: 100, width: 390, height: 44 });
	});

	test("reads fail at once when nothing or several match, and never wait", async () => {
		const { host, screen } = setup();
		expect((await failure(screen.getByTestId("nope").text())).code).toBe("LOCATOR_NOT_FOUND");
		expect((await failure(screen.getByRole("button").text())).code).toBe("LOCATOR_AMBIGUOUS");
		expect((await failure(screen.getByTestId("nope").boundingBox())).code).toBe("LOCATOR_NOT_FOUND");
		expect(host.clock.sleeps).toEqual([]);
	});

	test("reads are not reported as steps", async () => {
		const { host, screen } = setup();
		await screen.getByTestId("title").text();
		expect(host.steps).toEqual([]);
	});
});

describe("waitFor", () => {
	function appearing(after: number) {
		let snapshots = 0;
		return fakeDriver({
			screens: () => (snapshots++ < after ? snapshotOf([]) : snapshotOf([el("button", { id: "b" })])),
		});
	}

	test("visible is the default and polls until the element shows", async () => {
		const { host, screen } = setup(appearing(3));
		await screen.getByTestId("b").waitFor();
		expect(host.clock.sleeps).toEqual([100, 100, 100]);
	});

	test("attached and detached", async () => {
		const { screen } = setup(appearing(1));
		await screen.getByTestId("b").waitFor({ state: "attached" });
		await screen.getByTestId("nope").waitFor({ state: "detached" });
	});

	test("hidden accepts absent or hidden", async () => {
		const { screen } = setup(staticDriver([el("button", { id: "h", hidden: true })]));
		await screen.getByTestId("h").waitFor({ state: "hidden" });
		await screen.getByTestId("nope").waitFor({ state: "hidden" });
	});

	test("a state never reached is TIMEOUT with the screen", async () => {
		const { host, screen } = setup();
		const error = await failure(screen.getByTestId("nope").waitFor({ timeout: 300 }));
		expect(error.code).toBe("TIMEOUT");
		expect(error.message).toContain("visible");
		expect(error.screen).toContain("# ios");
		expect(host.clock.elapsed()).toBe(300);
	});

	test("several matches are ambiguous at once", async () => {
		const { screen } = setup();
		expect((await failure(screen.getByRole("button").waitFor())).code).toBe("LOCATOR_AMBIGUOUS");
	});

	test("an unknown state is INVALID_ARGUMENT", async () => {
		const { screen } = setup();
		// @ts-expect-error not a state
		expect((await failure(screen.getByTestId("title").waitFor({ state: "ready" }))).code).toBe("INVALID_ARGUMENT");
	});
});

describe("refinement and scoping", () => {
	test("first, last and nth pick among current matches", async () => {
		const { screen } = setup();
		const buttons = screen.getByRole("button");
		expect(await buttons.first().text()).toBe("Sign in");
		expect(await buttons.last().text()).toBe("Later");
		expect(await buttons.nth(1).text()).toBe("Later");
		expect(await buttons.nth(5).count()).toBe(0);
	});

	test("filter by text and by inner locator", async () => {
		const { screen } = setup();
		const cards = screen.getByTestId(/^card/);
		expect(await cards.filter({ hasText: "invoice 43" }).count()).toBe(1);
		expect(await cards.filter({ has: screen.getByText("$10") }).count()).toBe(1);
		expect(await cards.filter({ hasText: /^Invoice 4\d$/ }).count()).toBe(2);
	});

	test("filter needs hasText or has, and only those", () => {
		const { screen } = setup();
		const cards = screen.getByTestId(/^card/);
		expect(() => cards.filter({})).toThrow(E2eError);
		// @ts-expect-error unknown filter
		expect(() => cards.filter({ hasNotText: "x" })).toThrow(E2eError);
		// @ts-expect-error not a locator
		expect(() => cards.filter({ has: "x" })).toThrow(E2eError);
		expect(() => cards.nth(-1)).toThrow(E2eError);
		expect(() => cards.nth(1.5)).toThrow(E2eError);
	});

	test("queries on a locator run inside its subtree", async () => {
		const { screen } = setup();
		expect(await screen.getByTestId("card").getByText("Invoice 42").text()).toBe("Invoice 42");
		expect(await screen.getByTestId("card").getByText("Invoice 43").count()).toBe(0);
		expect(await screen.getByTestId("card2").getByText("Invoice 43").count()).toBe(1);
	});

	test("locator() takes a selector string, also scoped", async () => {
		const { screen } = setup();
		expect(await screen.locator("id=submit role=button").text()).toBe("Sign in");
		expect(await screen.locator("role=button nth=1").text()).toBe("Later");
		expect(await screen.getByTestId("card").locator("label=invoice").text()).toBe("Invoice 42");
		expect(() => screen.locator("color=red")).toThrow(E2eError);
	});

	test("a locator describes itself", () => {
		const { screen } = setup();
		expect(String(screen.getByTestId("card").getByText("x").first())).toBe(
			'getByTestId("card").getByText("x").first()'
		);
	});
});
