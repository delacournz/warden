import { describe, expect, test } from "bun:test";
import { ok } from "@delacour/warden-types/result";
import type { ReactTree, TreeComponent, TreeOptions } from "../devtools/devtools.types";
import { el } from "../driver/driver.testing";
import { E2eError } from "../errors";
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

const PAY: TreeComponent = {
	id: 0,
	name: "Pressable",
	testID: "pay",
	parent: null,
	rect: { x: 10, y: 20, width: 100, height: 40 },
};

/** A devtools facet that answers `tree` with whatever `components()` returns now, counting the calls. */
function fakeFacet(components: () => TreeComponent[] = () => [PAY]) {
	const calls: (TreeOptions | undefined)[] = [];
	return {
		calls,
		facet: {
			tree: async (options?: TreeOptions) => {
				calls.push(options);
				const tree: ReactTree = { components: components(), truncated: false };
				return ok(tree);
			},
		},
	};
}

function setup(options: { platform?: "ios" | "android"; devtools?: boolean; components?: () => TreeComponent[] } = {}) {
	const driver = staticDriver([el("button", { id: "other", label: "Other" })], options.platform);
	const host = testHost(driver);
	const fake = fakeFacet(options.components);
	if (options.devtools !== false) host.devtools = () => fake.facet;
	return { driver, host, fake, screen: createScreen(host) };
}

describe("getByTestId falls back to the React tree", () => {
	test("tap hits the centre of the component's rect", async () => {
		const { driver, screen, fake } = setup();
		await screen.getByTestId("pay").tap();
		expect(driver.callsOf("tap")).toEqual([{ method: "tap", point: { x: 60, y: 40 } }]);
		expect(fake.calls).toHaveLength(1);
	});

	test("position is an offset from the rect's corner", async () => {
		const { driver, screen } = setup();
		await screen.getByTestId("pay").tap({ position: { x: 5, y: 7 } });
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 15, y: 27 });
	});

	test("Android rects are asked for in pixels", async () => {
		const { screen, fake } = setup({ platform: "android" });
		await screen.getByTestId("pay").tap();
		expect(fake.calls[0]?.pixelRatio).toBe(3);
	});

	test("iOS rects need no scaling", async () => {
		const { screen, fake } = setup({ platform: "ios" });
		await screen.getByTestId("pay").tap();
		expect(fake.calls[0]?.pixelRatio).toBeUndefined();
	});

	test("boundingBox answers with the React rect", async () => {
		const { screen } = setup();
		expect(await screen.getByTestId("pay").boundingBox()).toEqual({ x: 10, y: 20, width: 100, height: 40 });
	});

	test("a component that appears a moment later is tapped", async () => {
		let visible = false;
		const { driver, screen, host } = setup({ components: () => (visible ? [PAY] : []) });
		const originalSleep = host.clock.sleep;
		host.clock.sleep = async (ms) => {
			await originalSleep(ms);
			if (host.clock.elapsed() >= 500) visible = true;
		};
		await screen.getByTestId("pay").tap();
		expect(driver.callsOf("tap")).toHaveLength(1);
	});

	test("two components with that testID are ambiguous", async () => {
		const twin: TreeComponent = { ...PAY, id: 1, rect: { x: 0, y: 100, width: 10, height: 10 } };
		const { screen } = setup({ components: () => [PAY, twin] });
		const error = await failure(screen.getByTestId("pay").tap());
		expect(error.code).toBe("LOCATOR_AMBIGUOUS");
		expect(error.matches).toBe(2);
	});

	test("a component off screen is not tapped", async () => {
		const away: TreeComponent = { ...PAY, rect: { x: 10, y: 5000, width: 100, height: 40 } };
		const { driver, screen } = setup({ components: () => [away] });
		const error = await failure(screen.getByTestId("pay").tap());
		expect(error.code).toBe("NOT_ACTIONABLE");
		expect(driver.callsOf("tap")).toEqual([]);
	});
});

describe("what the fallback does not do", () => {
	test("the accessibility tree wins and devtools is never asked", async () => {
		const { driver, screen, fake } = setup();
		await screen.getByTestId("other").tap();
		expect(driver.callsOf("tap")).toHaveLength(1);
		expect(fake.calls).toEqual([]);
	});

	test("without devtools the locator is simply not found", async () => {
		const { screen } = setup({ devtools: false });
		const error = await failure(screen.getByTestId("pay").tap({ timeout: 300 }));
		expect(error.code).toBe("LOCATOR_NOT_FOUND");
	});

	test("devtools that is down is not found either", async () => {
		const { screen, host } = setup();
		host.devtools = () => undefined;
		const error = await failure(screen.getByTestId("pay").tap({ timeout: 300 }));
		expect(error.code).toBe("LOCATOR_NOT_FOUND");
	});

	test("other queries and scoped test ids do not look in React", async () => {
		const { screen, fake } = setup();
		const a = await failure(screen.getByText("Pay").tap({ timeout: 200 }));
		const b = await failure(screen.getByRole("button", "Pay").tap({ timeout: 200 }));
		const c = await failure(screen.getByTestId("other").getByTestId("pay").tap({ timeout: 200 }));
		expect([a.code, b.code, c.code]).toEqual(["LOCATOR_NOT_FOUND", "LOCATOR_NOT_FOUND", "LOCATOR_NOT_FOUND"]);
		expect(fake.calls).toEqual([]);
	});

	test("count and isVisible stay accessibility-only", async () => {
		const { screen, fake } = setup();
		expect(await screen.getByTestId("pay").count()).toBe(0);
		expect(await screen.getByTestId("pay").isVisible()).toBe(false);
		expect(fake.calls).toEqual([]);
	});

	test("every action but tap refuses, saying why", async () => {
		const { screen, driver } = setup();
		const pay = screen.getByTestId("pay");
		const refused = await Promise.all([
			failure(pay.longPress({ timeout: 300 })),
			failure(pay.fill("x", { timeout: 300 })),
			failure(pay.clear({ timeout: 300 })),
			failure(pay.type("x", { timeout: 300 })),
			failure(pay.press("Enter", { timeout: 300 })),
			failure(pay.swipe({ direction: "down", timeout: 300 })),
		]);
		for (const error of refused) {
			expect(error.code).toBe("NOT_ACTIONABLE");
			expect(error.message).toContain("React tree");
			expect(error.message).toContain("tap()");
		}
		expect(driver.calls.filter((call) => call.method !== "snapshot")).toEqual([]);
	});

	test("reads that need an accessibility node refuse too", async () => {
		const { screen } = setup();
		const pay = screen.getByTestId("pay");
		for (const read of [() => pay.text(), () => pay.value(), () => pay.isEnabled(), () => pay.isChecked()]) {
			const error = await failure(read());
			expect(error.code).toBe("NOT_ACTIONABLE");
			expect(error.message).toContain("React tree");
		}
	});

	test("a testID the React tree does not have is a plain not found", async () => {
		const { screen } = setup();
		const error = await failure(screen.getByTestId("missing").tap({ timeout: 300 }));
		expect(error.code).toBe("LOCATOR_NOT_FOUND");
	});

	test("the tree is asked for at most every ~450 ms while polling", async () => {
		const { screen, fake, host } = setup({ components: () => [] });
		await failure(screen.getByTestId("pay").tap({ timeout: 2000 }));
		const elapsed = host.clock.elapsed();
		expect(fake.calls.length).toBeGreaterThanOrEqual(2);
		expect(fake.calls.length).toBeLessThanOrEqual(Math.floor(elapsed / 450) + 1);
	});
});
