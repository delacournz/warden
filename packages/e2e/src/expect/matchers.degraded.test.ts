import { describe, expect, test } from "bun:test";
import { el, snapshotOf } from "../driver/driver.testing";
import { E2eError } from "../errors";
import {
	type DegradedOptions,
	degradedHost,
	EMAIL_ERROR_COMPONENT,
	EMAIL_ERROR_TEXT,
	ERROR_COMPONENT,
	emptyRootSnapshot,
	FORM_ERROR_COMPONENT,
	lossySnapshot,
	measuredLossySnapshot,
} from "../screen/degraded.testing";
import { createScreen } from "../screen/screen";
import { staticDriver, testHost } from "../screen/screen.testing";
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

function setup(options: Parameters<typeof degradedHost>[0] = {}) {
	const made = degradedHost(options);
	const screen = createScreen(made.host);
	const that = (negate = false) => new LocatorAssertions(screen.getByTestId("error"), { negate });
	return { ...made, screen, that };
}

describe("a testID missing from a read that fell back from axbridge", () => {
	test("toBeHidden does not pass on it: it fails READ_DEGRADED at the timeout", async () => {
		const { that } = setup();
		const error = await failure(that().toBeHidden({ timeout: 500 }));
		expect(error.code).toBe("READ_DEGRADED");
		expect(error.message).toContain("axbridge");
		expect(error.message).toContain("ax");
		expect(error.message).toContain('getByTestId("error")');
	});

	test("not.toBeVisible does not pass on it either", async () => {
		const { that } = setup();
		const error = await failure(that(true).toBeVisible({ timeout: 500 }));
		expect(error.code).toBe("READ_DEGRADED");
	});

	test("toHaveCount(0) does not pass on it", async () => {
		const { that } = setup();
		const error = await failure(that().toHaveCount(0, { timeout: 500 }));
		expect(error.code).toBe("READ_DEGRADED");
	});

	test("toBeVisible fails READ_DEGRADED, not a plain assertion", async () => {
		const { that } = setup();
		const error = await failure(that().toBeVisible({ timeout: 500 }));
		expect(error.code).toBe("READ_DEGRADED");
	});

	test("an empty root counts as degraded too", async () => {
		const { that } = setup({ screen: () => emptyRootSnapshot() });
		const error = await failure(that().toBeHidden({ timeout: 500 }));
		expect(error.code).toBe("READ_DEGRADED");
		expect(error.message).toContain("empty root");
	});

	test("keeps polling and passes once a whole read shows the answer", async () => {
		let reads = 0;
		const { that } = setup({
			screen: () => (reads++ < 3 ? lossySnapshot() : snapshotOf([el("text", { label: "Too short" })])),
		});
		await that().toBeHidden({ timeout: 2000 });
		expect(reads).toBeGreaterThan(3);
	});
});

describe("the React tree answers for a degraded read", () => {
	test("present in the React tree: toBeVisible passes", async () => {
		const { that, reactReads } = setup({ react: () => [ERROR_COMPONENT] });
		await that().toBeVisible({ timeout: 500 });
		expect(reactReads()).toBeGreaterThan(0);
	});

	test("present in the React tree: toBeHidden fails as an assertion", async () => {
		const { that } = setup({ react: () => [ERROR_COMPONENT] });
		const error = await failure(that().toBeHidden({ timeout: 500 }));
		expect(error.code).toBe("ASSERTION");
	});

	test("absent from the React tree: toBeHidden passes", async () => {
		const { that } = setup({ react: () => [] });
		await that().toBeHidden({ timeout: 500 });
	});

	test("present in the React tree: toHaveCount(1) passes", async () => {
		const { that } = setup({ react: () => [ERROR_COMPONENT] });
		await that().toHaveCount(1, { timeout: 500 });
	});

	test("a query the React tree cannot answer (not a plain testID) still fails READ_DEGRADED", async () => {
		const { screen } = setup({ react: () => [ERROR_COMPONENT] });
		const locator = screen.getByText("Gone");
		const error = await failure(new LocatorAssertions(locator, { negate: false }).toBeHidden({ timeout: 500 }));
		expect(error.code).toBe("READ_DEGRADED");
	});
});

describe("a healthy read is unchanged", () => {
	test("toBeHidden passes at once on a testID that is not there", async () => {
		const host = testHost(staticDriver([el("text", { label: "Too short" })]));
		await new LocatorAssertions(createScreen(host).getByTestId("error"), { negate: false }).toBeHidden();
		expect(host.clock.sleeps).toEqual([]);
	});

	test("a match found on a degraded read is judged as usual", async () => {
		const { screen } = setup({ screen: () => lossySnapshot([el("text", { label: "Too short", id: "error" })]) });
		await new LocatorAssertions(screen.getByTestId("error"), { negate: false }).toBeVisible({ timeout: 500 });
	});
});

describe("text matchers on a degraded read", () => {
	function assertOn(testId: string, react: DegradedOptions["react"], negate = false) {
		const { screen } = setup({ screen: () => measuredLossySnapshot(), react });
		return new LocatorAssertions(screen.getByTestId(testId), { negate });
	}

	test("toHaveText passes on the node the React rect names", async () => {
		await assertOn("sign-in-email-error", () => [EMAIL_ERROR_COMPONENT]).toHaveText(EMAIL_ERROR_TEXT, { timeout: 500 });
	});

	test("toHaveText with the wrong text fails as an assertion, with the node's text", async () => {
		const error = await failure(
			assertOn("sign-in-email-error", () => [EMAIL_ERROR_COMPONENT]).toHaveText("Nope", { timeout: 300 })
		);
		expect(error.code).toBe("ASSERTION");
		expect(error.message).toContain(EMAIL_ERROR_TEXT);
	});

	test("toHaveText / toContainText judge the React tree's text when no node has its rect", async () => {
		await assertOn("sign-in-error", () => [FORM_ERROR_COMPONENT]).toHaveText(
			"This account is locked. Try another email.",
			{ timeout: 500 }
		);
		await assertOn("sign-in-error", () => [FORM_ERROR_COMPONENT]).toContainText("locked", { timeout: 500 });
		const error = await failure(
			assertOn("sign-in-error", () => [FORM_ERROR_COMPONENT]).toHaveText("Welcome", { timeout: 300 })
		);
		expect(error.code).toBe("ASSERTION");
		expect(error.message).toContain("React tree");
	});

	test("a React-only component without text cannot pass toHaveText", async () => {
		const error = await failure(assertOn("error", () => [ERROR_COMPONENT]).toHaveText("x", { timeout: 300 }));
		expect(error.code).toBe("ASSERTION");
		expect(error.message).toContain("only in the React tree");
	});
});
