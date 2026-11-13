import { describe, expect, test } from "bun:test";
import { el, snapshotOf } from "../driver/driver.testing";
import { E2eError } from "../errors";
import {
	type DegradedOptions,
	degradedHost,
	EMAIL_ERROR_COMPONENT,
	EMAIL_ERROR_FRAME,
	EMAIL_ERROR_TEXT,
	ERROR_COMPONENT,
	emptyRootSnapshot,
	FORM_ERROR_COMPONENT,
	lossySnapshot,
	measuredLossySnapshot,
} from "./degraded.testing";
import { createScreen } from "./screen";
import { staticDriver, testHost } from "./screen.testing";

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
	const made = degradedHost({ actionTimeoutMs: 500, ...options });
	return { ...made, screen: createScreen(made.host) };
}

describe("locator reads on a degraded read", () => {
	test("isVisible / isHidden / count do not answer 'absent': READ_DEGRADED after the action timeout", async () => {
		const { screen } = setup();
		const locator = screen.getByTestId("error");
		expect((await failure(locator.isHidden())).code).toBe("READ_DEGRADED");
		expect((await failure(locator.isVisible())).code).toBe("READ_DEGRADED");
		expect((await failure(locator.count())).code).toBe("READ_DEGRADED");
		expect((await failure(locator.read())).code).toBe("READ_DEGRADED");
	});

	test("text() fails READ_DEGRADED, not LOCATOR_NOT_FOUND", async () => {
		const { screen } = setup();
		const error = await failure(screen.getByTestId("error").text());
		expect(error.code).toBe("READ_DEGRADED");
		expect(error.message).toContain("fell back from axbridge");
	});

	test("the React tree answers presence", async () => {
		const { screen } = setup({ react: () => [ERROR_COMPONENT] });
		const locator = screen.getByTestId("error");
		expect(await locator.isVisible()).toBe(true);
		expect(await locator.count()).toBe(1);
		expect(await locator.boundingBox()).toEqual(ERROR_COMPONENT.rect ?? { x: 0, y: 0, width: 0, height: 0 });
	});

	test("the React tree answers absence", async () => {
		const { screen } = setup({ react: () => [] });
		const locator = screen.getByTestId("error");
		expect(await locator.isHidden()).toBe(true);
		expect(await locator.count()).toBe(0);
	});

	test("a healthy read still answers absence at once", async () => {
		const host = testHost(staticDriver([el("text", { label: "Too short" })]));
		expect(await createScreen(host).getByTestId("error").isHidden()).toBe(true);
		expect(host.clock.sleeps).toEqual([]);
	});
});

describe("quick checks on a degraded read wait a short window, not the action timeout", () => {
	test("isVisible / isHidden / count give up after 2000 ms with READ_DEGRADED", async () => {
		for (const check of ["isVisible", "isHidden", "count"] as const) {
			const { screen, host } = setup({ actionTimeoutMs: 30_000 });
			const start = host.clock.now();
			const error = await failure(screen.getByTestId("error")[check]());
			expect(error.code).toBe("READ_DEGRADED");
			expect(error.message).toContain("within 2000 ms");
			expect(host.clock.now() - start).toBeLessThan(5000);
		}
	});

	test("an action timeout shorter than the window wins", async () => {
		const { screen } = setup({ actionTimeoutMs: 500 });
		expect((await failure(screen.getByTestId("error").isVisible())).message).toContain("within 500 ms");
	});

	test("text() / read() still wait the whole action timeout", async () => {
		const { screen } = setup({ actionTimeoutMs: 30_000 });
		const locator = screen.getByTestId("error");
		expect((await failure(locator.text())).message).toContain("within 30000 ms");
		expect((await failure(locator.read())).message).toContain("within 30000 ms");
	});

	test("a read that recovers inside the window answers", async () => {
		let reads = 0;
		const { screen } = setup({
			actionTimeoutMs: 30_000,
			screen: () => {
				reads += 1;
				return reads < 3 ? lossySnapshot() : snapshotOf([el("text", { id: "error", label: "Too short" })]);
			},
		});
		expect(await screen.getByTestId("error").isVisible()).toBe(true);
	});
});

describe("waits and actions on a degraded read", () => {
	test("waitFor hidden does not pass: READ_DEGRADED", async () => {
		const { screen } = setup();
		const error = await failure(screen.getByTestId("error").waitFor({ state: "hidden" }));
		expect(error.code).toBe("READ_DEGRADED");
	});

	test("waitFor detached on an empty root: READ_DEGRADED", async () => {
		const { screen } = setup({ screen: () => emptyRootSnapshot() });
		const error = await failure(screen.getByTestId("error").waitFor({ state: "detached" }));
		expect(error.code).toBe("READ_DEGRADED");
	});

	test("waitFor hidden passes when the React tree says it is gone", async () => {
		const { screen } = setup({ react: () => [] });
		await screen.getByTestId("error").waitFor({ state: "hidden" });
	});

	test("tap fails READ_DEGRADED, not LOCATOR_NOT_FOUND, when nothing can confirm the testID", async () => {
		const { screen } = setup();
		const error = await failure(screen.getByTestId("error").tap());
		expect(error.code).toBe("READ_DEGRADED");
	});

	test("tap uses the React tree's rect", async () => {
		const { screen, driver } = setup({ react: () => [ERROR_COMPONENT] });
		await screen.getByTestId("error").tap();
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 60, y: 40 });
	});

	test("tap still fails LOCATOR_NOT_FOUND when the React tree says it is absent", async () => {
		const { screen } = setup({ react: () => [] });
		const error = await failure(screen.getByTestId("error").tap());
		expect(error.code).toBe("LOCATOR_NOT_FOUND");
	});
});

describe("text and visibility of a testID on a degraded read", () => {
	function measured(react: DegradedOptions["react"]) {
		return setup({ screen: () => measuredLossySnapshot(), react });
	}

	test("the React rect names the accessibility node: text() reads that node", async () => {
		const { screen } = measured(() => [EMAIL_ERROR_COMPONENT]);
		expect(await screen.getByTestId("sign-in-email-error").text()).toBe(EMAIL_ERROR_TEXT);
	});

	test("read() / allTexts() / isVisible() come from the paired node", async () => {
		const { screen } = measured(() => [EMAIL_ERROR_COMPONENT]);
		const locator = screen.getByTestId("sign-in-email-error");
		expect(await locator.read()).toEqual({ visible: true, text: EMAIL_ERROR_TEXT, value: "" });
		expect(await locator.allTexts()).toEqual([EMAIL_ERROR_TEXT]);
		expect(await locator.isVisible()).toBe(true);
	});

	test("tap lands on the paired node's centre", async () => {
		const { screen, driver } = measured(() => [EMAIL_ERROR_COMPONENT]);
		await screen.getByTestId("sign-in-email-error").tap();
		const { x, y, width, height } = EMAIL_ERROR_FRAME;
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: x + width / 2, y: y + height / 2 });
	});

	test("no node with the component's rect: text() is the React tree's text", async () => {
		const { screen } = measured(() => [FORM_ERROR_COMPONENT]);
		const locator = screen.getByTestId("sign-in-error");
		expect(await locator.text()).toBe("This account is locked. Try another email.");
		expect(await locator.read()).toEqual({ visible: true, text: "This account is locked. Try another email." });
		expect(await locator.allTexts()).toEqual(["This account is locked. Try another email."]);
	});

	test("a React-only component without text still cannot answer text()", async () => {
		const { screen } = measured(() => [ERROR_COMPONENT]);
		expect((await failure(screen.getByTestId("error").text())).code).toBe("NOT_ACTIONABLE");
	});

	test("tap({ until }) on a testID the React rect names arrives with one press", async () => {
		const { screen, driver } = measured(() => [EMAIL_ERROR_COMPONENT]);
		await screen.getByTestId("sign-in-email").tap({ until: screen.getByTestId("sign-in-email-error") });
		expect(driver.callsOf("tap")).toHaveLength(1);
	});

	test("a healthy read never consults the React tree for a node it lacks", async () => {
		const made = degradedHost({
			screen: () => ({ ...measuredLossySnapshot(), fellBackFrom: undefined }),
			react: () => [EMAIL_ERROR_COMPONENT],
		});
		const screen = createScreen(made.host);
		expect(await screen.getByTestId("sign-in-email-error").isHidden()).toBe(true);
	});
});
