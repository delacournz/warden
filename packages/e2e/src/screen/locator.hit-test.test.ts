import { describe, expect, test } from "bun:test";
import { type ElementSpec, el, failWith, fakeDriver, snapshotOf } from "../driver/driver.testing";
import type { Snapshot } from "../driver/driver.types";
import { LocatorAssertions } from "../expect/matchers";
import { createScreen } from "./screen";
import { testHost } from "./screen.testing";

/**
 * Assert-then-tap on a driver whose hit-test is cheap (iOS): the snapshot the assertion kept is checked by one
 * `elementAtPoint` at the tap point instead of a second whole snapshot, and only when the hit is the same element in
 * the same place.
 */

const NEXT = { x: 24, y: 600, width: 300, height: 44 };
const nextButton = (frame = NEXT, extra: Partial<ElementSpec> = {}): ElementSpec =>
	el("button", { id: "next", label: "Next", hittable: true, frame, ...extra });

function setup(
	options: { screens?: Snapshot[]; cheap?: boolean; onCall?: Parameters<typeof fakeDriver>[0]["onCall"] } = {}
) {
	const driver = fakeDriver({
		screens: options.screens ?? [snapshotOf([nextButton()])],
		capabilities: { cheapHitTest: options.cheap ?? true },
		...(options.onCall === undefined ? {} : { onCall: options.onCall }),
	});
	const host = testHost(driver, { cache: true });
	return { driver, host, screen: createScreen(host) };
}

const visible = (screen: ReturnType<typeof setup>["screen"]) =>
	new LocatorAssertions(screen.getByTestId("next"), { negate: false }).toBeVisible();
const count = (driver: ReturnType<typeof setup>["driver"], method: "snapshot" | "elementAtPoint" | "tap") =>
	driver.callsOf(method).length;

describe("assert-then-tap with a cheap hit-test", () => {
	test("is one snapshot and one hit-test at the tap point when the element is still there", async () => {
		const { driver, screen } = setup();
		await visible(screen);
		await screen.getByTestId("next").tap();
		expect(count(driver, "snapshot")).toBe(1);
		expect(driver.callsOf("elementAtPoint")).toEqual([{ method: "elementAtPoint", point: { x: 174, y: 622 } }]);
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 174, y: 622 });
	});

	test("a tap at a position hit-tests that position", async () => {
		const { driver, screen } = setup();
		await visible(screen);
		await screen.getByTestId("next").tap({ position: { x: 1, y: 1 } });
		expect(count(driver, "snapshot")).toBe(1);
		expect(driver.callsOf("elementAtPoint")[0]?.point).toEqual({ x: 25, y: 601 });
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 25, y: 601 });
	});

	test("an element that moved since the assertion is looked for again and tapped where it settled", async () => {
		const moved = { ...NEXT, y: 300 };
		const { driver, screen } = setup({ screens: [snapshotOf([nextButton()]), snapshotOf([nextButton(moved)])] });
		await visible(screen);
		driver.advance();
		await screen.getByTestId("next").tap();
		expect(count(driver, "elementAtPoint")).toBe(1);
		expect(count(driver, "snapshot")).toBeGreaterThanOrEqual(2);
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 174, y: 322 });
	});

	test("a hit on something else (a child label, a neighbour) falls back to a fresh snapshot", async () => {
		const label = el("text", { label: "Next", frame: { x: 150, y: 610, width: 50, height: 20 } });
		const { driver, screen } = setup({ screens: [snapshotOf([nextButton(NEXT, { children: [label] })])] });
		await visible(screen);
		await screen.getByTestId("next").tap();
		expect(count(driver, "elementAtPoint")).toBe(1);
		expect(count(driver, "snapshot")).toBe(2);
		expect(count(driver, "tap")).toBe(1);
	});

	test("the same frame with another name, or now disabled, is not the same element", async () => {
		for (const changed of [nextButton(NEXT, { label: "Done" }), nextButton(NEXT, { enabled: false })]) {
			const { driver, screen } = setup({
				screens: [snapshotOf([nextButton()])],
				onCall: (call) =>
					call.method === "elementAtPoint" ? { data: snapshotOf([changed]).flat[0] ?? null } : undefined,
			});
			await visible(screen);
			await screen.getByTestId("next").tap();
			expect(count(driver, "snapshot")).toBe(2);
		}
	});

	test("a hit-test that fails falls back to a fresh snapshot", async () => {
		const { driver, screen } = setup({
			onCall: (call) => (call.method === "elementAtPoint" ? failWith("E_AX_UNAVAILABLE") : undefined),
		});
		await visible(screen);
		await screen.getByTestId("next").tap();
		expect(count(driver, "snapshot")).toBe(2);
		expect(count(driver, "tap")).toBe(1);
	});

	test("a kept snapshot 150 ms old or more is not used: the tap looks for itself", async () => {
		const { driver, host, screen } = setup();
		await visible(screen);
		host.clock.advance(150);
		await screen.getByTestId("next").tap();
		expect(count(driver, "elementAtPoint")).toBe(0);
		expect(count(driver, "snapshot")).toBe(2);
	});

	test("an input since the kept snapshot means a fresh look", async () => {
		const { driver, screen } = setup();
		await visible(screen);
		await screen.tapAt({ x: 1, y: 1 });
		await screen.getByTestId("next").tap();
		expect(count(driver, "elementAtPoint")).toBe(0);
	});

	test("with nothing kept the tap takes its own snapshot and no hit-test", async () => {
		const { driver, screen } = setup();
		await screen.getByTestId("next").tap();
		expect(count(driver, "elementAtPoint")).toBe(0);
		expect(count(driver, "snapshot")).toBe(1);
	});

	test("a kept snapshot with an alert on it is not aimed from", async () => {
		const { driver, screen } = setup({ screens: [snapshotOf([nextButton()], { modal: { description: "sheet" } })] });
		await visible(screen);
		await screen.getByTestId("next").tap();
		expect(count(driver, "elementAtPoint")).toBe(0);
	});

	test("a disabled match on the kept snapshot is not hit-tested: the tap waits as before", async () => {
		const { driver, screen } = setup({
			screens: [snapshotOf([nextButton(NEXT, { enabled: false })]), snapshotOf([nextButton()])],
		});
		await new LocatorAssertions(screen.getByTestId("next"), { negate: false }).toBeVisible();
		driver.advance();
		await screen.getByTestId("next").tap();
		expect(count(driver, "elementAtPoint")).toBe(0);
		expect(count(driver, "tap")).toBe(1);
	});

	test("several matches on the kept snapshot still fail as before", async () => {
		const { screen } = setup({ screens: [snapshotOf([nextButton(), nextButton({ ...NEXT, y: 100 })])] });
		await screen.getByTestId("next").count();
		await expect(screen.getByTestId("next").tap()).rejects.toThrow();
	});

	test("a driver whose hit-test is no cheaper than a snapshot (Android) takes the second snapshot as before", async () => {
		const { driver, screen } = setup({ cheap: false });
		await visible(screen);
		await screen.getByTestId("next").tap();
		expect(count(driver, "elementAtPoint")).toBe(0);
		expect(count(driver, "snapshot")).toBe(2);
	});

	test("a tap with until keeps aiming from the kept snapshot and still sees the press land", async () => {
		let pressed = false;
		const driver = fakeDriver({
			screens: () => snapshotOf(pressed ? [el("text", { id: "done", label: "Done" })] : [nextButton()]),
			capabilities: { cheapHitTest: true },
			onCall: (call) => {
				if (call.method === "tap") pressed = true;
				return undefined;
			},
		});
		const screen = createScreen(testHost(driver, { cache: true }));
		await visible(screen);
		await screen.getByTestId("next").tap({ until: screen.getByTestId("done") });
		expect(count(driver, "tap")).toBe(1);
		expect(count(driver, "elementAtPoint")).toBe(1);
	});
});
