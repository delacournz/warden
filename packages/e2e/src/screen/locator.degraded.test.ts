import { describe, expect, test } from "bun:test";
import { el } from "../driver/driver.testing";
import { E2eError } from "../errors";
import { degradedHost, ERROR_COMPONENT, emptyRootSnapshot } from "./degraded.testing";
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
