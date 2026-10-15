import { describe, expect, test } from "bun:test";
import { el, fakeDriver, snapshotOf } from "../driver/driver.testing";
import { E2eError } from "../errors";
import { createScreen } from "../screen/screen";
import { fieldFixture, staticDriver, testHost } from "../screen/screen.testing";
import { LocatorAssertions } from "./matchers";

async function failure(promise: Promise<unknown>): Promise<E2eError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof E2eError) return error;
		throw error;
	}
	throw new Error("did not reject");
}

function setup(
	driver = staticDriver([el("button", { id: "x", label: "b" })]),
	options: Parameters<typeof testHost>[1] = {}
) {
	const host = testHost(driver, options);
	const screen = createScreen(host);
	const that = (locator: ReturnType<typeof screen.getByTestId>, soft?: (error: E2eError) => void) =>
		new LocatorAssertions(locator, { negate: false, ...(soft === undefined ? {} : { soft }) });
	return { driver, host, screen, that };
}

/** A screen whose single element `x` appears after `after` snapshots. */
function appearing(after: number, spec = el("button", { id: "x", label: "b" })) {
	let snapshots = 0;
	return fakeDriver({ screens: () => (snapshots++ < after ? snapshotOf([]) : snapshotOf([spec])) });
}

/** A screen whose single element `x` is gone after `after` snapshots. */
function vanishing(after: number) {
	let snapshots = 0;
	return fakeDriver({
		screens: () => (snapshots++ < after ? snapshotOf([el("button", { id: "x" })]) : snapshotOf([])),
	});
}

describe("polling", () => {
	test("a matcher that already holds passes without sleeping", async () => {
		const { host, screen, that } = setup();
		await that(screen.getByTestId("x")).toBeVisible();
		expect(host.clock.sleeps).toEqual([]);
	});

	test("polls every 100 ms until the condition holds", async () => {
		const { host, screen, that } = setup(appearing(3));
		await that(screen.getByTestId("x")).toBeVisible();
		expect(host.clock.sleeps).toEqual([100, 100, 100]);
	});

	test("never holding fails with ASSERTION at the assertion timeout", async () => {
		const { host, screen, that } = setup(appearing(1_000_000));
		const error = await failure(that(screen.getByTestId("x")).toBeVisible());
		expect(error.code).toBe("ASSERTION");
		expect(host.clock.elapsed()).toBe(5000);
	});

	test("{ timeout } overrides the assertion timeout, and so does the host", async () => {
		const { host, screen, that } = setup(appearing(1_000_000));
		await failure(that(screen.getByTestId("x")).toBeVisible({ timeout: 300 }));
		expect(host.clock.elapsed()).toBe(300);
		host.assertionTimeout = () => 200;
		await failure(that(screen.getByTestId("x")).toBeVisible());
		expect(host.clock.elapsed()).toBe(500);
	});

	test("a retryable driver failure is polled through, a fatal one thrown", async () => {
		let reads = 0;
		const flaky = fakeDriver({
			screens: [snapshotOf([el("button", { id: "x" })])],
			onCall: (call) =>
				call.method === "snapshot" && reads++ < 2
					? { error: { code: "E_AX_UNAVAILABLE", message: "busy", retryable: true } }
					: undefined,
		});
		const one = setup(flaky);
		await one.that(one.screen.getByTestId("x")).toBeVisible();
		expect(one.host.clock.sleeps).toEqual([100, 100]);

		const broken = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (call) =>
				call.method === "snapshot"
					? { error: { code: "E_HELPER_CRASHED", message: "gone", retryable: false } }
					: undefined,
		});
		const two = setup(broken);
		expect((await failure(two.that(two.screen.getByTestId("x")).toBeVisible())).code).toBe("DRIVER");
	});

	test("an aborted attempt stops the poll with its own error", async () => {
		const { host, screen, that } = setup(appearing(1_000_000));
		const controller = new AbortController();
		controller.abort(new E2eError("TIMEOUT", "test timed out after 5s"));
		host.signal = controller.signal;
		const error = await failure(that(screen.getByTestId("x")).toBeVisible());
		expect(error.message).toBe("test timed out after 5s");
	});

	test("several matches fail at once with LOCATOR_AMBIGUOUS", async () => {
		const { host, screen, that } = setup(staticDriver([el("button", { label: "a" }), el("button", { label: "a" })]));
		const error = await failure(that(screen.getByRole("button")).toBeVisible());
		expect(error.code).toBe("LOCATOR_AMBIGUOUS");
		expect(host.clock.sleeps).toEqual([]);
	});

	test("each matcher is one reported step", async () => {
		const { host, screen, that } = setup();
		await that(screen.getByTestId("x")).toBeVisible();
		await that(screen.getByTestId("x")).toHaveText("b", { exact: false });
		expect(host.steps).toEqual(['expect getByTestId("x").toBeVisible()', 'expect getByTestId("x").toHaveText("b")']);
	});

	test("an option the matcher does not take is INVALID_ARGUMENT before any read", async () => {
		const { driver, screen, that } = setup();
		// @ts-expect-error not an option
		expect((await failure(that(screen.getByTestId("x")).toBeVisible({ visibel: true }))).code).toBe("INVALID_ARGUMENT");
		// @ts-expect-error checked must be a boolean
		expect((await failure(that(screen.getByTestId("x")).toBeChecked({ checked: "no" }))).code).toBe("INVALID_ARGUMENT");
		expect(driver.callsOf("snapshot")).toEqual([]);
	});
});

describe("failure messages", () => {
	test("header, expected, received and the screen", async () => {
		const { screen, that } = setup(undefined, { assertionTimeoutMs: 300 });
		const error = await failure(that(screen.getByTestId("x")).toHaveText("a"));
		expect(error.message).toBe(
			[
				'expect(getByTestId("x")).toHaveText("a")',
				'Expected: "a"',
				'Received: "b"',
				"",
				"# ios axbridge 390×844@3x · 1 of 1 elements (interactive)",
				'[button] "b" id=x enabled (0,0 390×44)',
			].join("\n")
		);
		expect(error.screen).toContain("# ios axbridge");
		expect(error.code).toBe("ASSERTION");
	});

	test("negated matchers say not", async () => {
		const { screen } = setup();
		const negated = new LocatorAssertions(screen.getByTestId("x"), { negate: true });
		const error = await failure(negated.toHaveText("b"));
		expect(error.message).toContain('expect(getByTestId("x")).not.toHaveText("b")\nExpected: not "b"\nReceived: "b"');
	});

	test("a missing element reads as not found", async () => {
		const { screen, that } = setup(staticDriver([]));
		const error = await failure(that(screen.getByTestId("x")).toHaveText("a", { timeout: 100 }));
		expect(error.message).toContain("Received: element not found");
	});

	test("a regexp is printed as written", async () => {
		const { screen, that } = setup();
		const error = await failure(that(screen.getByTestId("x")).toHaveText(/^a/, { timeout: 0 }));
		expect(error.message).toContain("Expected: /^a/");
	});
});

describe("toBeVisible / toBeHidden", () => {
	test("visible: hidden elements and missing ones do not pass", async () => {
		const hidden = setup(staticDriver([el("button", { id: "x", hidden: true })]));
		expect(
			(await failure(hidden.that(hidden.screen.getByTestId("x")).toBeVisible({ timeout: 200 }))).message
		).toContain("Received: hidden");
		const missing = setup(staticDriver([]));
		expect(
			(await failure(missing.that(missing.screen.getByTestId("x")).toBeVisible({ timeout: 200 }))).message
		).toContain("Received: not found");
	});

	test("hidden: absent or hidden pass, visible does not", async () => {
		const absent = setup(staticDriver([]));
		await absent.that(absent.screen.getByTestId("x")).toBeHidden();
		const hidden = setup(staticDriver([el("button", { id: "x", hidden: true })]));
		await hidden.that(hidden.screen.getByTestId("x")).toBeHidden();
		const shown = setup();
		const error = await failure(shown.that(shown.screen.getByTestId("x")).toBeHidden({ timeout: 200 }));
		expect(error.message).toContain("Expected: hidden");
		expect(error.message).toContain("Received: visible");
	});

	test("hidden waits for the element to go away", async () => {
		const { host, screen, that } = setup(vanishing(2));
		await that(screen.getByTestId("x")).toBeHidden();
		expect(host.clock.sleeps).toEqual([100, 100]);
	});
});

describe("negation", () => {
	test("passes only after the negated condition held for 1000 ms", async () => {
		const { host, screen } = setup(staticDriver([]));
		await new LocatorAssertions(screen.getByTestId("x"), { negate: true }).toBeVisible();
		expect(host.clock.elapsed()).toBe(1000);
		expect(host.clock.sleeps).toEqual(Array.from({ length: 10 }, () => 100));
	});

	test("a flicker restarts the window", async () => {
		let reads = 0;
		const driver = fakeDriver({
			screens: () => (reads++ === 3 ? snapshotOf([el("button", { id: "x" })]) : snapshotOf([])),
		});
		const { host, screen } = setup(driver);
		await new LocatorAssertions(screen.getByTestId("x"), { negate: true }).toBeVisible();
		expect(host.clock.elapsed()).toBe(1400);
	});

	test("a short timeout is held for in full", async () => {
		const { host, screen } = setup(staticDriver([]));
		await new LocatorAssertions(screen.getByTestId("x"), { negate: true }).toBeVisible({ timeout: 300 });
		expect(host.clock.elapsed()).toBe(300);
	});

	test("fails when the condition never goes away", async () => {
		const { screen } = setup(staticDriver([el("button", { id: "x" })]), { assertionTimeoutMs: 2000 });
		const error = await failure(new LocatorAssertions(screen.getByTestId("x"), { negate: true }).toBeVisible());
		expect(error.message).toContain("Expected: not visible");
		expect(error.message).toContain("Received: visible");
	});

	test("`.not` returns the inverted assertions", async () => {
		const { screen, that } = setup();
		const negated = that(screen.getByTestId("x")).not;
		expect(negated).toBeInstanceOf(LocatorAssertions);
		expect(negated.not.not).toBeInstanceOf(LocatorAssertions);
		await negated.not.toBeVisible();
	});

	test("on a missing element, text-like matchers keep failing rather than pass", async () => {
		const { screen } = setup(staticDriver([]), { assertionTimeoutMs: 400 });
		const negated = new LocatorAssertions(screen.getByTestId("x"), { negate: true });
		expect((await failure(negated.toHaveText("a"))).message).toContain("Received: element not found");
	});
});

describe("text matchers", () => {
	test("toHaveText is whole-text after normalisation; exact:false is a case-insensitive substring", async () => {
		const { screen, that } = setup(staticDriver([el("text", { id: "t", label: "  Hello   World " })]));
		await that(screen.getByTestId("t")).toHaveText("Hello World");
		await that(screen.getByTestId("t")).toHaveText(/^hello/i);
		await that(screen.getByTestId("t")).toHaveText("world", { exact: false });
		expect((await failure(that(screen.getByTestId("t")).toHaveText("Hello", { timeout: 100 }))).code).toBe("ASSERTION");
	});

	test("toHaveText falls back to descendant text", async () => {
		const { screen, that } = setup(
			staticDriver([
				el("other", { id: "card", children: [el("text", { label: "Invoice 42" }), el("text", { label: "$10" })] }),
			])
		);
		await that(screen.getByTestId("card")).toHaveText("Invoice 42 $10");
	});

	test("toContainText is a case-sensitive substring, ignoreCase relaxes it", async () => {
		const { screen, that } = setup(staticDriver([el("text", { id: "t", label: "Saved at 10:42" })]));
		await that(screen.getByTestId("t")).toContainText("Saved");
		await that(screen.getByTestId("t")).toContainText(/\d+:\d+/);
		expect((await failure(that(screen.getByTestId("t")).toContainText("saved", { timeout: 100 }))).code).toBe(
			"ASSERTION"
		);
		await that(screen.getByTestId("t")).toContainText("saved", { ignoreCase: true });
	});

	test("waits for the text to change", async () => {
		let reads = 0;
		const driver = fakeDriver({
			screens: () => snapshotOf([el("text", { id: "t", label: reads++ < 2 ? "Saving…" : "Saved" })]),
		});
		const { host, screen, that } = setup(driver);
		await that(screen.getByTestId("t")).toHaveText("Saved");
		expect(host.clock.sleeps).toEqual([100, 100]);
	});
});

describe("toHaveValue", () => {
	test("compares the field value as it is", async () => {
		const { driver } = fieldFixture({ value: "me@x.co" });
		const { screen, that } = setup(driver);
		await that(screen.getByTestId("field")).toHaveValue("me@x.co");
		await that(screen.getByTestId("field")).toHaveValue(/@x\.co$/);
		expect((await failure(that(screen.getByTestId("field")).toHaveValue("me@x", { timeout: 100 }))).message).toContain(
			'Received: "me@x.co"'
		);
	});

	test("an empty field reads as an empty string", async () => {
		const { driver } = fieldFixture();
		const { screen, that } = setup(driver);
		await that(screen.getByTestId("field")).toHaveValue("");
	});

	test("secure fields are never judged", async () => {
		const { driver } = fieldFixture({ secure: true, value: "hunter2" });
		const { screen, that } = setup(driver);
		const error = await failure(that(screen.getByTestId("field")).toHaveValue("", { timeout: 100 }));
		expect(error.code).toBe("INVALID_ARGUMENT");
		expect(error.message).toContain("secure");
	});
});

describe("state matchers", () => {
	const screenOf = () =>
		setup(
			staticDriver([
				el("switch", { id: "on", value: "1" }),
				el("switch", { id: "off", value: "0" }),
				el("button", { id: "plain" }),
				el("button", { id: "dead", enabled: false }),
			])
		);

	test("toBeChecked defaults to checked, checked:false expects unchecked, non-checkable counts unchecked", async () => {
		const { screen, that } = screenOf();
		await that(screen.getByTestId("on")).toBeChecked();
		await that(screen.getByTestId("off")).toBeChecked({ checked: false });
		await that(screen.getByTestId("plain")).toBeChecked({ checked: false });
		const error = await failure(that(screen.getByTestId("off")).toBeChecked({ timeout: 100 }));
		expect(error.message).toContain("Expected: checked");
		expect(error.message).toContain("Received: unchecked");
	});

	test("toBeEnabled / toBeDisabled", async () => {
		const { screen, that } = screenOf();
		await that(screen.getByTestId("plain")).toBeEnabled();
		await that(screen.getByTestId("dead")).toBeDisabled();
		const error = await failure(that(screen.getByTestId("dead")).toBeEnabled({ timeout: 100 }));
		expect(error.message).toContain("Received: disabled");
	});

	test("state matchers on a missing element keep polling and fail", async () => {
		const { host, screen, that } = screenOf();
		const error = await failure(that(screen.getByTestId("nope")).toBeEnabled({ timeout: 300 }));
		expect(error.message).toContain("Received: element not found");
		expect(host.clock.elapsed()).toBe(300);
	});
});

describe("toHaveCount", () => {
	test("counts current matches, zero included", async () => {
		const { screen, that } = setup(staticDriver([el("button", { label: "a" }), el("button", { label: "b" })]));
		await that(screen.getByRole("button")).toHaveCount(2);
		await that(screen.getByRole("tab")).toHaveCount(0);
		const error = await failure(that(screen.getByRole("button")).toHaveCount(3, { timeout: 100 }));
		expect(error.message).toContain("Expected: 3");
		expect(error.message).toContain("Received: 2");
	});

	test("waits for the count", async () => {
		let reads = 0;
		const driver = fakeDriver({
			screens: () =>
				snapshotOf(Array.from({ length: Math.min(reads++, 3) }, (_, i) => el("button", { label: `b${i}` }))),
		});
		const { host, screen, that } = setup(driver);
		await that(screen.getByRole("button")).toHaveCount(3);
		expect(host.clock.sleeps).toEqual([100, 100, 100]);
	});

	test("not.toHaveCount", async () => {
		const { screen } = setup(staticDriver([el("button", { label: "a" })]));
		await new LocatorAssertions(screen.getByRole("button"), { negate: true }).toHaveCount(2);
	});

	test("rejects a non-integer count", async () => {
		const { screen, that } = setup();
		expect((await failure(that(screen.getByRole("button")).toHaveCount(1.5))).code).toBe("INVALID_ARGUMENT");
	});
});

describe("soft", () => {
	test("failures go to the collector instead of throwing", async () => {
		const collected: E2eError[] = [];
		const { screen, that } = setup(undefined, { assertionTimeoutMs: 200 });
		const soft = (error: E2eError) => collected.push(error);
		await that(screen.getByTestId("x"), soft).toHaveText("a");
		await that(screen.getByTestId("x"), soft).toBeHidden();
		await that(screen.getByTestId("x"), soft).toBeVisible();
		expect(collected.map((error) => error.code)).toEqual(["ASSERTION", "ASSERTION"]);
	});

	test("an ambiguous locator is collected too, but an aborted attempt is not", async () => {
		const collected: E2eError[] = [];
		const soft = (error: E2eError) => collected.push(error);
		const many = setup(staticDriver([el("button", { label: "a" }), el("button", { label: "a" })]));
		await many.that(many.screen.getByRole("button"), soft).toBeVisible();
		expect(collected.map((error) => error.code)).toEqual(["LOCATOR_AMBIGUOUS"]);

		const { host, screen, that } = setup(appearing(1_000_000));
		const controller = new AbortController();
		controller.abort(new E2eError("TIMEOUT", "test timed out after 5s"));
		host.signal = controller.signal;
		expect((await failure(that(screen.getByTestId("x"), soft).toBeVisible())).code).toBe("TIMEOUT");
		expect(collected).toHaveLength(1);
	});
});
