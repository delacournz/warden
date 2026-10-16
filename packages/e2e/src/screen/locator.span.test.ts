import { describe, expect, test } from "bun:test";
import { el } from "../driver/driver.testing";
import { runSpan } from "../runner/span";
import type { TraceEvent } from "../runner/trace";
import { createScreen } from "./screen";
import { staticDriver, testHost } from "./screen.testing";

function setup(options: { withSpans?: boolean } = {}) {
	const events: TraceEvent[] = [];
	const sink = { write: (event: TraceEvent) => void events.push(event) };
	const host = testHost(
		staticDriver([
			el("text", { id: "title", label: "Welcome" }),
			el("switch", { id: "remember", label: "Remember me", value: "1", checked: true }),
			el("textfield", { id: "email", label: "Email", value: "me@x.co" }),
			el("button", { id: "submit", label: "Sign in", hittable: true }),
		])
	);
	if (options.withSpans !== false) host.span = (op, fn, spanOptions) => runSpan(sink, op, fn, spanOptions);
	const spans = () => events.flatMap((e) => (e.type === "span" ? [e] : []));
	return { screen: createScreen(host), spans };
}

describe("locator reads are trace spans", () => {
	test("every read is a read.<name> span that names its locator", async () => {
		const { screen, spans } = setup();
		const title = screen.getByTestId("title");
		await title.isVisible();
		await title.text();
		await title.count();
		await title.allTexts();
		await title.isEnabled();
		await title.boundingBox();
		await screen.getByTestId("email").value();
		await screen.getByTestId("remember").isChecked();
		await title.waitFor();
		expect(spans().map((s) => s.op)).toEqual([
			"read.isVisible",
			"read.text",
			"read.count",
			"read.allTexts",
			"read.isEnabled",
			"read.boundingBox",
			"read.value",
			"read.isChecked",
			"read.waitFor",
		]);
		expect(spans()[0]?.detail).toEqual({ locator: 'getByTestId("title")' });
		expect(spans().every((s) => s.ok)).toBe(true);
	});

	test("the answers are unchanged", async () => {
		const { screen } = setup();
		expect(await screen.getByTestId("title").text()).toBe("Welcome");
		expect(await screen.getByTestId("email").value()).toBe("me@x.co");
		expect(await screen.getByTestId("title").count()).toBe(1);
		expect(await screen.getByTestId("nope").isVisible()).toBe(false);
	});

	test("a read that throws is an ok:false span with the locator error code", async () => {
		const { screen, spans } = setup();
		await expect(screen.getByTestId("nope").text()).rejects.toMatchObject({ code: "LOCATOR_NOT_FOUND" });
		expect(spans()[0]).toMatchObject({ op: "read.text", ok: false, code: "LOCATOR_NOT_FOUND" });
	});

	test("isHidden is one read, not two", async () => {
		const { screen, spans } = setup();
		await screen.getByTestId("title").isHidden();
		expect(spans().map((s) => s.op)).toEqual(["read.isVisible"]);
	});

	test("actions are steps, not reads", async () => {
		const { screen, spans } = setup();
		await screen.getByTestId("submit").tap();
		expect(spans()).toEqual([]);
	});

	test("a host without a span runner reads as before", async () => {
		const { screen } = setup({ withSpans: false });
		expect(await screen.getByTestId("title").text()).toBe("Welcome");
		expect(await screen.getByTestId("title").waitFor()).toBeUndefined();
	});
});
