import { describe, expect, spyOn, test } from "bun:test";
import { el, type FakeDriver, fakeDriver, snapshotOf } from "../driver/driver.testing";
import { E2eError } from "../errors";
import { LocatorAssertions } from "../expect/matchers";
import { Runtime } from "./context";
import { createScreen } from "./screen";
import { fieldFixture, staticDriver, testHost } from "./screen.testing";

/**
 * The failure excerpt (the interactive tree rendered into an error) costs an index and up to 40 rendered lines. It is
 * for people reading a failure, so nothing on the way to a success may pay for it.
 */

async function failure(promise: Promise<unknown>): Promise<E2eError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof E2eError) return error;
		throw error;
	}
	throw new Error("did not reject");
}

/** How many times the screen was rendered for an error while `run` ran. */
async function excerptsBuiltBy(run: () => Promise<unknown>): Promise<number> {
	const spy = spyOn(Runtime.prototype, "excerpt");
	try {
		await run();
		return spy.mock.calls.length;
	} finally {
		spy.mockRestore();
	}
}

/** The error `run` fails with, and how many times the screen was rendered on the way. */
async function failedWith(run: () => Promise<unknown>): Promise<{ built: number; error: E2eError }> {
	const spy = spyOn(Runtime.prototype, "excerpt");
	try {
		const error = await failure(run());
		return { built: spy.mock.calls.length, error };
	} finally {
		spy.mockRestore();
	}
}

function login(): FakeDriver {
	return staticDriver([
		el("text", { id: "title", label: "Welcome" }),
		el("textfield", { id: "email", label: "Email", value: "me@x.co" }),
		el("button", { id: "submit", label: "Sign in", hittable: true }),
		el("switch", { id: "remember", label: "Remember me", value: "1" }),
		el("other", { id: "card", children: [el("text", { label: "Invoice 42" }), el("text", { label: "$10" })] }),
	]);
}

/** A screen whose element `x` shows up after `after` reads; every read labels the screen with its number. */
function appearing(after: number): FakeDriver {
	let reads = 0;
	return fakeDriver({
		screens: () => {
			reads += 1;
			const marker = el("text", { id: "marker", label: `read ${reads}` });
			return snapshotOf(reads > after ? [marker, el("button", { id: "x", label: "b" })] : [marker]);
		},
	});
}

function setup(driver: FakeDriver, options: Parameters<typeof testHost>[1] = {}) {
	const host = testHost(driver, options);
	return { driver, host, screen: createScreen(host) };
}

describe("a success never renders the screen", () => {
	test("actions on a single match", async () => {
		const { screen } = setup(login());
		expect(
			await excerptsBuiltBy(async () => {
				await screen.getByTestId("submit").tap();
				await screen.getByTestId("submit").longPress();
			})
		).toBe(0);
	});

	test("reads of a single match", async () => {
		const { screen } = setup(login());
		const submit = screen.getByTestId("submit");
		expect(
			await excerptsBuiltBy(async () => {
				await submit.text();
				await submit.value();
				await submit.isVisible();
				await submit.isHidden();
				await submit.isEnabled();
				await submit.isChecked();
				await submit.boundingBox();
				await screen.getByTestId("card").text();
				await screen.getByRole("button").count();
				await screen.getByRole("text").allTexts();
			})
		).toBe(0);
	});

	test("waitFor and scrollTo", async () => {
		const { screen } = setup(login());
		expect(
			await excerptsBuiltBy(async () => {
				await screen.getByTestId("submit").waitFor();
				await screen.getByTestId("submit").waitFor({ state: "attached" });
				await screen.getByTestId("submit").scrollTo();
			})
		).toBe(0);
	});

	test("an action that waits through polls without its target", async () => {
		const { screen } = setup(appearing(3));
		expect(await excerptsBuiltBy(() => screen.getByTestId("x").tap())).toBe(0);
	});

	test("a waitFor that polls without its target", async () => {
		const { screen } = setup(appearing(3));
		expect(await excerptsBuiltBy(() => screen.getByTestId("x").waitFor())).toBe(0);
	});

	test("matchers, including the polls before they hold and a held negation", async () => {
		const { screen } = setup(appearing(3));
		const assertions = new LocatorAssertions(screen.getByTestId("x"), { negate: false });
		expect(await excerptsBuiltBy(() => assertions.toBeVisible())).toBe(0);
		expect(await excerptsBuiltBy(() => assertions.toHaveText("b"))).toBe(0);
		const absent = setup(login());
		const negated = new LocatorAssertions(absent.screen.getByTestId("nope"), { negate: true });
		expect(await excerptsBuiltBy(() => negated.toBeVisible())).toBe(0);
	});

	test("fill confirmed by a hit-test", async () => {
		const { driver } = fieldFixture();
		const { screen } = setup(driver);
		expect(await excerptsBuiltBy(() => screen.getByTestId("field").fill("hi"))).toBe(0);
	});

	test("fill confirmed by the snapshot fallback", async () => {
		const { driver } = fieldFixture();
		const noHitTest: FakeDriver = { ...driver, elementAtPoint: async () => ({ success: true, data: null }) };
		const { screen } = setup(noHitTest);
		expect(await excerptsBuiltBy(() => screen.getByTestId("field").fill("hi"))).toBe(0);
	});
});

describe("a failure renders the screen from the last read", () => {
	test("an ambiguous match", async () => {
		const driver = staticDriver([el("button", { id: "a", label: "A" }), el("button", { id: "b", label: "B" })]);
		const { host, screen } = setup(driver);
		const { built, error } = await failedWith(() => screen.getByRole("button").tap());
		expect(built).toBe(1);
		expect(error.code).toBe("LOCATOR_AMBIGUOUS");
		expect(error.screen).toBe(new Runtime(host).excerpt(driver.screen));
	});

	test("a read that finds nothing", async () => {
		const driver = login();
		const { host, screen } = setup(driver);
		const { built, error } = await failedWith(() => screen.getByTestId("nope").text());
		expect(built).toBe(1);
		expect(error.code).toBe("LOCATOR_NOT_FOUND");
		expect(error.screen).toBe(new Runtime(host).excerpt(driver.screen));
	});

	test("an action that gives up shows the last screen it polled", async () => {
		const { screen } = setup(appearing(1_000_000), { actionTimeoutMs: 300 });
		const { built, error } = await failedWith(() => screen.getByTestId("x").tap());
		expect(built).toBe(1);
		expect(error.screen).toContain('"read 4"');
	});

	test("a matcher that never holds shows the last screen it polled, in the message and on the error", async () => {
		const { screen } = setup(appearing(1_000_000), { assertionTimeoutMs: 300 });
		const { built, error } = await failedWith(() =>
			new LocatorAssertions(screen.getByTestId("x"), { negate: false }).toBeVisible()
		);
		expect(built).toBe(1);
		expect(error.message).toMatch(/Received: not found\n\n# ios axbridge [^\n]*\n[^\n]*"read 4"/);
		expect(error.screen).toContain('"read 4"');
		expect(error.message.endsWith(error.screen ?? "?")).toBe(true);
	});

	test("a matcher that cannot read the screen has no excerpt to show", async () => {
		const flaky = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (call) =>
				call.method === "snapshot"
					? { error: { code: "E_AX_UNAVAILABLE", message: "busy", retryable: true } }
					: undefined,
		});
		const { screen } = setup(flaky, { assertionTimeoutMs: 300 });
		const { built, error } = await failedWith(() =>
			new LocatorAssertions(screen.getByTestId("x"), { negate: false }).toBeVisible()
		);
		expect(built).toBe(0);
		expect(error.message).toBe(
			'expect(getByTestId("x")).toBeVisible()\nExpected: visible\nReceived: (screen unreadable)'
		);
		expect(error.screen).toBeUndefined();
	});

	test("a fill that did not take shows what the confirm read, not one render per read", async () => {
		const { driver } = fieldFixture({ dropTypes: 2 });
		const noHitTest: FakeDriver = { ...driver, elementAtPoint: async () => ({ success: true, data: null }) };
		const { screen } = setup(noHitTest, { actionTimeoutMs: 5000 });
		const { built, error } = await failedWith(() => screen.getByTestId("field").fill("hi"));
		expect(error.code).toBe("ACTION_FAILED");
		expect(error.screen).toContain("id=field");
		expect(built).toBeGreaterThanOrEqual(1);
		expect(built).toBeLessThanOrEqual(2);
	});
});
