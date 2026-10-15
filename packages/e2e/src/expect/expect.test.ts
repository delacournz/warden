import type { Matchers } from "bun:test";
import { expect as bun, describe, test } from "bun:test";
import { el } from "../driver/driver.testing";
import { E2eError } from "../errors";
import type { Locator } from "../screen/locator";
import { createScreen } from "../screen/screen";
import { staticDriver, testHost } from "../screen/screen.testing";
import { createExpect, expect, softSinkFor } from "./expect";
import { LocatorAssertions } from "./matchers";

function screenWithButton() {
	const host = testHost(staticDriver([el("button", { id: "x", label: "b" })]), { assertionTimeoutMs: 200 });
	return { host, screen: createScreen(host) };
}

describe("expect(actual)", () => {
	test("a value goes to bun's expect", () => {
		expect(1).toBe(1);
		expect({ a: [1, 2] }).toEqual({ a: [1, 2] });
		bun(() => expect(1).toBe(2)).toThrow();
		expect(1).not.toBe(2);
	});

	test("a failing value matcher throws bun's error, not an E2eError", () => {
		let thrown: unknown;
		try {
			expect(1).toBe(2);
		} catch (error) {
			thrown = error;
		}
		bun(thrown).toBeInstanceOf(Error);
		bun(thrown).not.toBeInstanceOf(E2eError);
	});

	test("a locator goes to the locator matchers", async () => {
		const { screen } = screenWithButton();
		const assertions = expect(screen.getByTestId("x"));
		bun(assertions).toBeInstanceOf(LocatorAssertions);
		await assertions.toBeVisible();
		await expect(screen.getByTestId("x")).not.toBeHidden({ timeout: 100 });
	});

	test("bun's statics are on the wrapper", () => {
		expect("abc").toEqual(expect.any(String));
		expect([1, 2, 3]).toEqual(expect.arrayContaining([2]));
		expect({ a: 1, b: 2 }).toEqual(expect.objectContaining({ a: 1 }));
		expect("hello").toEqual(expect.stringContaining("ell"));
		expect("hello").toEqual(expect.not.stringContaining("xyz"));
		expect("hello").toEqual(expect.stringMatching(/^h/));
		expect(2).toEqual(expect.anything());
	});

	test("expect.extend registers matchers that expect(value) then has", () => {
		expect.extend({
			toBeFortyTwo(actual: unknown) {
				return { pass: actual === 42, message: () => "expected 42" };
			},
		});
		// the extension is not in the static types; the runtime must still reach it
		const matchers = expect(42) as unknown as { toBeFortyTwo(): void };
		matchers.toBeFortyTwo();
	});

	test("expect(locator) is not bun's: value matchers are type errors", () => {
		const { screen } = screenWithButton();
		const locator = screen.getByTestId("x");
		// @ts-expect-error a locator has no toBe
		const wrong = () => expect(locator).toBe(1);
		// @ts-expect-error a number has no toBeVisible
		const alsoWrong = () => expect(1).toBeVisible();
		bun(typeof wrong).toBe("function");
		bun(typeof alsoWrong).toBe("function");
	});

	test("overloads: values are typed as bun's Matchers, locators as LocatorAssertions", () => {
		const { screen } = screenWithButton();
		const value: Matchers<number> = expect(1);
		const locator: LocatorAssertions = expect(screen.getByTestId("x"));
		const generic: LocatorAssertions = expect.soft(screen.getByTestId("x"));
		const softValue: Matchers<string> = expect.soft("x");
		bun([value, locator, generic, softValue]).toHaveLength(4);
	});
});

describe("expect.soft", () => {
	function collecting() {
		const failures: E2eError[] = [];
		const soft = createExpect({ softSink: () => (error) => void failures.push(error) }).soft;
		return { failures, soft };
	}

	test("locator failures are kept, the test continues", async () => {
		const { failures, soft } = collecting();
		const { screen } = screenWithButton();
		await soft(screen.getByTestId("x")).toHaveText("zzz");
		await soft(screen.getByTestId("x")).toBeHidden();
		await soft(screen.getByTestId("x")).toBeVisible();
		bun(failures.map((failure) => failure.code)).toEqual(["ASSERTION", "ASSERTION"]);
		bun(failures[0]?.message).toContain('expect(getByTestId("x")).toHaveText("zzz")');
	});

	test("value failures are kept as ASSERTION errors, sync and async", async () => {
		const { failures, soft } = collecting();
		soft(1).toBe(2);
		soft("a").not.toBe("a");
		await soft(Promise.resolve(1)).resolves.toBe(3);
		soft(1).toBe(1);
		bun(failures).toHaveLength(3);
		bun(failures.every((failure) => failure instanceof E2eError && failure.code === "ASSERTION")).toBe(true);
	});

	test("without an attempt to collect for, failures throw as usual", async () => {
		const loose = createExpect({ softSink: () => undefined }).soft;
		bun(() => loose(1).toBe(2)).toThrow();
		const { screen } = screenWithButton();
		let thrown: unknown;
		try {
			await loose(screen.getByTestId("x")).toHaveText("zzz");
		} catch (error) {
			thrown = error;
		}
		bun(thrown).toBeInstanceOf(E2eError);
	});

	test("the real expect.soft outside warden just throws", () => {
		bun(() => expect.soft(1).toBe(2)).toThrow();
	});

	test("the session's collector is the running attempt's softFailures", () => {
		const softFailures: E2eError[] = [];
		const sink = softSinkFor({ attempt: { softFailures } as never });
		sink?.(new E2eError("ASSERTION", "x"));
		bun(softFailures).toHaveLength(1);
		bun(softSinkFor({ attempt: undefined })).toBeUndefined();
	});

	test("typed as the locator matchers for a locator", () => {
		const { screen } = screenWithButton();
		const locator: Locator = screen.getByTestId("x");
		bun(typeof createExpect({ softSink: () => undefined }).soft(locator).toBeVisible).toBe("function");
	});
});
