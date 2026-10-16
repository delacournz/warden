import { describe, expect, test } from "bun:test";
import { el } from "../driver/driver.testing";
import { E2eError } from "../errors";
import { createScreen } from "./screen";
import { staticDriver, testHost } from "./screen.testing";

function setup(options: Parameters<typeof testHost>[1] = {}) {
	const driver = staticDriver([
		el("text", { id: "title", label: "Plan" }),
		el("textfield", { id: "email", label: "Email", value: "me@x.co" }),
		el("switch", { id: "remember", label: "Remember me", value: "1" }),
		el("switch", { id: "newsletter", label: "Newsletter", value: "0" }),
		el("text", { id: "ghost", label: "Ghost", hidden: true }),
		el("button", { id: "dup", label: "Same" }),
		el("button", { id: "dup", label: "Same" }),
	]);
	const host = testHost(driver, options);
	return { driver, host, screen: createScreen(host) };
}

describe("locator.read", () => {
	test("visible, text and value of one node", async () => {
		const { screen } = setup();
		expect(await screen.getByTestId("title").read()).toEqual({ visible: true, text: "Plan", value: "" });
		expect(await screen.getByTestId("email").read()).toEqual({ visible: true, text: "Email", value: "me@x.co" });
	});

	test("what text(), value() and isVisible() return, from one look", async () => {
		const { screen } = setup();
		const email = screen.getByTestId("email");
		const reading = await email.read();
		expect(reading.visible).toBe(await email.isVisible());
		expect(reading.text).toBe(await email.text());
		expect(reading.value).toBe(await email.value());
	});

	test("checked is there for a node that can be checked", async () => {
		const { screen } = setup();
		expect((await screen.getByTestId("remember").read()).checked).toBe(true);
		expect((await screen.getByTestId("newsletter").read()).checked).toBe(false);
		expect("checked" in (await screen.getByTestId("title").read())).toBe(false);
	});

	test("no match is { visible: false } and does not wait", async () => {
		const { host, screen } = setup();
		expect(await screen.getByTestId("nope").read()).toEqual({ visible: false });
		expect(host.clock.sleeps).toEqual([]);
	});

	test("a node that is there but hidden still gives its text", async () => {
		const { screen } = setup();
		expect(await screen.getByTestId("ghost").read()).toEqual({ visible: false, text: "Ghost", value: "" });
	});

	test("several matches fail like text() does", async () => {
		const { screen } = setup();
		const error = await screen
			.getByTestId("dup")
			.read()
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(E2eError);
		expect((error as E2eError).code).toBe("LOCATOR_AMBIGUOUS");
	});

	test("takes one snapshot where the separate reads take one each", async () => {
		const { driver, screen } = setup();
		const email = screen.getByTestId("email");
		await email.read();
		expect(driver.callsOf("snapshot")).toHaveLength(1);
		await email.isVisible();
		await email.text();
		await email.value();
		expect(driver.callsOf("snapshot")).toHaveLength(4);
	});

	test("shares the kept snapshot when the observation cache is on", async () => {
		const { driver, screen } = setup({ cache: true });
		const email = screen.getByTestId("email");
		await email.read();
		await email.read();
		expect(driver.callsOf("snapshot")).toHaveLength(1);
	});

	test("is traced as read.read with the locator", async () => {
		const { driver, host } = setup();
		const spans: { op: string; detail?: Record<string, unknown> }[] = [];
		host.span = async (op, fn, options) => {
			const value = await fn();
			spans.push({ op, detail: options?.detail?.(value) });
			return value;
		};
		await createScreen(host).getByTestId("title").read();
		expect(spans).toEqual([{ op: "read.read", detail: { locator: 'getByTestId("title")' } }]);
		expect(driver.callsOf("snapshot")).toHaveLength(1);
	});
});
