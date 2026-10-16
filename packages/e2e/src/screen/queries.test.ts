import { describe, expect, test } from "bun:test";
import { E2eError } from "../errors";
import { roleQuery, selectorExpression, testIdQuery, textQuery, withScope } from "./queries";
import type { LocatorExpression } from "./query";

function thrown(fn: () => unknown): E2eError {
	try {
		fn();
	} catch (error) {
		if (error instanceof E2eError) return error;
		throw error;
	}
	throw new Error("did not throw");
}

describe("query builders", () => {
	test("testId", () => {
		expect(testIdQuery("x")).toEqual({ kind: "testId", value: "x" });
		expect(testIdQuery(/x/, { visible: true })).toEqual({ kind: "testId", value: /x/, visible: true });
	});

	test("text-like queries keep only the options given", () => {
		expect(textQuery("text", "Save")).toEqual({ kind: "text", value: "Save" });
		expect(textQuery("label", "Email", { exact: false, visible: true })).toEqual({
			kind: "label",
			value: "Email",
			exact: false,
			visible: true,
		});
	});

	test("role accepts a name, options, or both", () => {
		expect(roleQuery("button")).toEqual({ kind: "role", role: "button" });
		expect(roleQuery("button", "Save")).toEqual({ kind: "role", role: "button", name: "Save" });
		expect(roleQuery("button", /Save/, { checked: true })).toEqual({
			kind: "role",
			role: "button",
			name: /Save/,
			checked: true,
		});
		expect(roleQuery("switch", { name: "Wi-Fi", disabled: false })).toEqual({
			kind: "role",
			role: "switch",
			name: "Wi-Fi",
			disabled: false,
		});
	});

	test("an unknown role is INVALID_LOCATOR and lists the vocabulary", () => {
		// @ts-expect-error not a role
		const error = thrown(() => roleQuery("textfield"));
		expect(error.code).toBe("INVALID_LOCATOR");
		expect(error.message).toContain("textbox");
	});

	test("an option the query does not take is INVALID_LOCATOR naming the keys it does", () => {
		// @ts-expect-error not an option
		const error = thrown(() => textQuery("text", "x", { nam: "y" }));
		expect(error.code).toBe("INVALID_LOCATOR");
		expect(error.message).toContain("nam");
		expect(error.message).toContain("exact");
		// @ts-expect-error not an option
		expect(thrown(() => testIdQuery("x", { exact: true })).code).toBe("INVALID_LOCATOR");
		// @ts-expect-error not an option
		expect(thrown(() => roleQuery("button", "x", { nme: 1 })).code).toBe("INVALID_LOCATOR");
	});
});

describe("selectorExpression", () => {
	test("parses a selector string", () => {
		expect(selectorExpression("id=a nth=1")).toEqual({
			kind: "index",
			index: 1,
			source: { kind: "query", query: { kind: "selector", selector: { id: { kind: "text", value: "a" } } } },
		});
	});

	test("a malformed selector is INVALID_LOCATOR with the parser's message", () => {
		const error = thrown(() => selectorExpression("color=red"));
		expect(error.code).toBe("INVALID_LOCATOR");
		expect(error.message).toContain('unknown key "color"');
	});
});

describe("withScope", () => {
	const scope: LocatorExpression = { kind: "query", query: { kind: "testId", value: "list" } };
	const inner: LocatorExpression = { kind: "query", query: { kind: "testId", value: "row" } };

	test("puts the scope on a query", () => {
		expect(withScope(inner, scope)).toEqual({ kind: "query", query: { kind: "testId", value: "row" }, scope });
	});

	test("nests below an existing scope", () => {
		const deeper: LocatorExpression = { kind: "query", query: { kind: "testId", value: "cell" }, scope: inner };
		expect(withScope(deeper, scope)).toEqual({
			kind: "query",
			query: { kind: "testId", value: "cell" },
			scope: { kind: "query", query: { kind: "testId", value: "row" }, scope },
		});
	});

	test("reaches through index and filter", () => {
		const wrapped: LocatorExpression = {
			kind: "index",
			index: 0,
			source: { kind: "filter", hasText: "x", source: inner },
		};
		expect(withScope(wrapped, scope)).toEqual({
			kind: "index",
			index: 0,
			source: {
				kind: "filter",
				hasText: "x",
				source: { kind: "query", query: { kind: "testId", value: "row" }, scope },
			},
		});
	});
});
