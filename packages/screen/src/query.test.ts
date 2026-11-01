import { describe, expect, test } from "bun:test";
import { elementFixtures } from "./element.testing";
import { type NodeEntry, nodeIndexer } from "./nodes";
import { type LocatorExpression, type Query, queryResolver } from "./query";
import { selectorEngine } from "./selector";
import type { TextMatch } from "./text";

const query = (q: Query, scope?: LocatorExpression): LocatorExpression =>
	scope === undefined ? { kind: "query", query: q } : { kind: "query", query: q, scope };
const byText = (value: TextMatch, exact?: boolean, visible?: boolean): LocatorExpression =>
	query({
		kind: "text",
		value,
		...(exact === undefined ? {} : { exact }),
		...(visible === undefined ? {} : { visible }),
	});
const byRole = (
	role: Extract<Query, { kind: "role" }>["role"],
	extra: Partial<Extract<Query, { kind: "role" }>> = {}
): LocatorExpression => query({ kind: "role", role, ...extra });

const ids = (entries: NodeEntry[]) => entries.map((entry) => entry.element.identifier ?? entry.element.label ?? "?");

/** Login form, an iOS-style echoed Text, a list with rows, a hidden duplicate and a closed drawer. */
function screen() {
	return nodeIndexer.indexSnapshot(
		elementFixtures.snap([
			elementFixtures.el("application", {}, [
				// iOS reports an RN Text as a host view plus a StaticText with the same label
				elementFixtures.el("other", { identifier: "greeting-host", label: "Welcome back" }, [
					elementFixtures.el("text", { identifier: "greeting", label: "Welcome back" }),
				]),
				elementFixtures.el("textfield", {
					identifier: "email",
					label: "Email",
					value: "",
					placeholder: "you@example.com",
				}),
				elementFixtures.el("securefield", {
					identifier: "password",
					label: "Password",
					value: "••••",
					placeholder: "Password",
				}),
				elementFixtures.el("button", { identifier: "sign-in-submit", label: "Sign in" }),
				elementFixtures.el("button", { identifier: "sign-in-disabled", label: "Sign in later", enabled: false }),
				elementFixtures.el("switch", { identifier: "remember", label: "Remember me", value: "1" }),
				elementFixtures.el("other", { identifier: "agree", label: "Agree", value: "checkbox, unchecked" }),
				elementFixtures.el("list", { identifier: "invoices" }, [
					elementFixtures.el("cell", { identifier: "row-1" }, [
						elementFixtures.el("text", { label: "Invoice 42" }),
						elementFixtures.el("text", { label: "$120.00" }),
						elementFixtures.el("button", { identifier: "void-1", label: "Void" }),
					]),
					elementFixtures.el("cell", { identifier: "row-2", selected: true }, [
						elementFixtures.el("text", { label: "Invoice 43" }),
						elementFixtures.el("text", { label: "$80.00" }),
						elementFixtures.el("button", { identifier: "void-2", label: "Void" }),
					]),
				]),
				elementFixtures.el("other", { identifier: "drawer", hidden: true }, [
					elementFixtures.el("button", { identifier: "drawer-save", label: "Save" }),
				]),
				elementFixtures.el("button", { identifier: "save", label: "Save" }),
				elementFixtures.el("text", { identifier: "empty-hidden", label: "No memories yet", hidden: true }),
				elementFixtures.el("text", { identifier: "empty-shown", label: "No memories yet" }),
			]),
		])
	);
}

describe("testId", () => {
	const index = screen();
	test("whole id, case-sensitive", () => {
		expect(ids(queryResolver.resolve(query({ kind: "testId", value: "email" }), index))).toEqual(["email"]);
		expect(queryResolver.resolve(query({ kind: "testId", value: "Email" }), index)).toEqual([]);
		expect(queryResolver.resolve(query({ kind: "testId", value: "emai" }), index)).toEqual([]);
	});

	test("regexp", () => {
		expect(ids(queryResolver.resolve(query({ kind: "testId", value: /^void-/ }), index))).toEqual(["void-1", "void-2"]);
	});
});

describe("text and label answer innermost matches", () => {
	const index = screen();

	test("an echoing host view is dropped", () => {
		expect(ids(queryResolver.resolve(byText("Welcome back"), index))).toEqual(["greeting"]);
		expect(ids(queryResolver.resolve(query({ kind: "label", value: "Welcome back" }), index))).toEqual(["greeting"]);
	});

	test("two matches that do not contain each other stay two", () => {
		expect(ids(queryResolver.resolve(byText("Void"), index))).toEqual(["void-1", "void-2"]);
	});

	test("whole-text by default, substring with exact:false", () => {
		expect(ids(queryResolver.resolve(byText("Sign in"), index))).toEqual(["sign-in-submit"]);
		expect(ids(queryResolver.resolve(byText("sign in", false), index))).toEqual(["sign-in-submit", "sign-in-disabled"]);
	});

	test("regexp", () => {
		expect(ids(queryResolver.resolve(byText(/^Invoice \d+$/), index))).toEqual(["Invoice 42", "Invoice 43"]);
	});

	test("label uses the accessible name; text also reads Android text", () => {
		const android = nodeIndexer.indexSnapshot(
			elementFixtures.snap([elementFixtures.el("text", { identifier: "t", text: "Plain text" })], {
				platform: "android",
			})
		);
		expect(ids(queryResolver.resolve(byText("Plain text"), android))).toEqual(["t"]);
		expect(ids(queryResolver.resolve(query({ kind: "label", value: "Plain text" }), android))).toEqual(["t"]);
	});
});

describe("placeholder and value", () => {
	const index = screen();
	test("placeholder", () => {
		expect(ids(queryResolver.resolve(query({ kind: "placeholder", value: "you@example.com" }), index))).toEqual([
			"email",
		]);
	});

	test("value matches the displayed value, secure fields expose none", () => {
		expect(ids(queryResolver.resolve(query({ kind: "value", value: "1" }), index))).toEqual(["remember"]);
		expect(queryResolver.resolve(query({ kind: "value", value: "••••" }), index)).toEqual([]);
	});

	test("React Native spelled prefix is not part of the value", () => {
		expect(queryResolver.resolve(query({ kind: "value", value: "checkbox, unchecked" }), index)).toEqual([]);
	});
});

describe("role queries", () => {
	const index = screen();

	test("by role in document order", () => {
		expect(ids(queryResolver.resolve(byRole("button"), index))).toEqual([
			"sign-in-submit",
			"sign-in-disabled",
			"void-1",
			"void-2",
			"save",
		]);
	});

	test("hidden nodes are dropped", () => {
		expect(ids(queryResolver.resolve(byRole("button", { name: "Save" }), index))).toEqual(["save"]);
	});

	test("name is whole-text unless exact:false", () => {
		expect(ids(queryResolver.resolve(byRole("button", { name: "Sign in" }), index))).toEqual(["sign-in-submit"]);
		expect(ids(queryResolver.resolve(byRole("button", { name: "sign in", exact: false }), index))).toEqual([
			"sign-in-submit",
			"sign-in-disabled",
		]);
		expect(ids(queryResolver.resolve(byRole("button", { name: /later$/ }), index))).toEqual(["sign-in-disabled"]);
	});

	test("disabled / checked / selected states", () => {
		expect(ids(queryResolver.resolve(byRole("button", { disabled: true }), index))).toEqual(["sign-in-disabled"]);
		expect(ids(queryResolver.resolve(byRole("button", { disabled: false, name: /^Sign/ }), index))).toEqual([
			"sign-in-submit",
		]);
		expect(ids(queryResolver.resolve(byRole("switch", { checked: true }), index))).toEqual(["remember"]);
		expect(queryResolver.resolve(byRole("switch", { checked: false }), index)).toEqual([]);
		expect(ids(queryResolver.resolve(byRole("checkbox", { checked: false }), index))).toEqual(["agree"]);
		expect(ids(queryResolver.resolve(byRole("listitem", { selected: true }), index))).toEqual(["row-2"]);
	});

	test("React Native spelled checkbox is found by role", () => {
		expect(ids(queryResolver.resolve(byRole("checkbox", { name: "Agree" }), index))).toEqual(["agree"]);
	});

	test("textbox covers text and secure fields", () => {
		expect(ids(queryResolver.resolve(byRole("textbox"), index))).toEqual(["email", "password"]);
	});
});

describe("visible", () => {
	const index = screen();

	test("non-role queries keep hidden nodes unless visible:true", () => {
		expect(ids(queryResolver.resolve(byText("No memories yet"), index))).toEqual(["empty-hidden", "empty-shown"]);
		expect(ids(queryResolver.resolve(byText("No memories yet", true, true), index))).toEqual(["empty-shown"]);
		expect(ids(queryResolver.resolve(query({ kind: "testId", value: "empty-hidden", visible: true }), index))).toEqual(
			[]
		);
	});

	test("visible:true is an explicit false-skip", () => {
		expect(ids(queryResolver.resolve(byText("No memories yet", true, false), index))).toEqual([
			"empty-hidden",
			"empty-shown",
		]);
	});
});

describe("scope", () => {
	const index = screen();
	const list = query({ kind: "testId", value: "invoices" });

	test("queries are restricted to strict descendants of the scope", () => {
		expect(ids(queryResolver.resolve(byRole("button"), index))).toHaveLength(5);
		const scoped = query({ kind: "role", role: "button" }, list);
		expect(ids(queryResolver.resolve(scoped, index))).toEqual(["void-1", "void-2"]);
	});

	test("the scope itself is not a candidate", () => {
		expect(queryResolver.resolve(query({ kind: "testId", value: "invoices" }, list), index)).toEqual([]);
	});

	test("innermost is computed inside the scope", () => {
		const row = query({ kind: "testId", value: "row-1" });
		expect(ids(queryResolver.resolve(byTextIn("Invoice 42", row), index))).toEqual(["Invoice 42"]);
		expect(queryResolver.resolve(byTextIn("Invoice 43", row), index)).toEqual([]);
	});

	test("an empty scope yields nothing", () => {
		const missing = query({ kind: "testId", value: "nope" });
		expect(queryResolver.resolve(query({ kind: "role", role: "button" }, missing), index)).toEqual([]);
	});
});

function byTextIn(value: string, scope: LocatorExpression): LocatorExpression {
	return query({ kind: "text", value }, scope);
}

describe("filter", () => {
	const index = screen();
	const rows = byRole("listitem");

	test("hasText is a case-insensitive substring over the subtree", () => {
		const filtered: LocatorExpression = { kind: "filter", source: rows, hasText: "invoice 42" };
		expect(ids(queryResolver.resolve(filtered, index))).toEqual(["row-1"]);
		expect(ids(queryResolver.resolve({ kind: "filter", source: rows, hasText: "$80" }, index))).toEqual(["row-2"]);
	});

	test("hasText regexp is applied as written", () => {
		expect(ids(queryResolver.resolve({ kind: "filter", source: rows, hasText: /^invoice 42$/ }, index))).toEqual([]);
		expect(ids(queryResolver.resolve({ kind: "filter", source: rows, hasText: /^Invoice 42$/ }, index))).toEqual([
			"row-1",
		]);
	});

	test("hasText sees the node's own text too", () => {
		expect(ids(queryResolver.resolve({ kind: "filter", source: byRole("button"), hasText: "void" }, index))).toEqual([
			"void-1",
			"void-2",
		]);
	});

	test("has keeps matches whose subtree resolves the inner locator", () => {
		const has = byText("Invoice 43");
		expect(ids(queryResolver.resolve({ kind: "filter", source: rows, has }, index))).toEqual(["row-2"]);
	});

	test("has is evaluated inside each match only", () => {
		const has = byRole("button", { name: "Void" });
		expect(ids(queryResolver.resolve({ kind: "filter", source: rows, has }, index))).toEqual(["row-1", "row-2"]);
		expect(ids(queryResolver.resolve({ kind: "filter", source: rows, has: byText("Sign in") }, index))).toEqual([]);
	});

	test("hasText and has combine as and", () => {
		expect(
			ids(queryResolver.resolve({ kind: "filter", source: rows, hasText: "42", has: byText("Invoice 43") }, index))
		).toEqual([]);
	});

	test("filter then query chains scope", () => {
		const row = { kind: "filter", source: rows, hasText: "Invoice 43" } satisfies LocatorExpression;
		expect(ids(queryResolver.resolve(query({ kind: "role", role: "button" }, row), index))).toEqual(["void-2"]);
	});
});

describe("index", () => {
	const index = screen();
	const buttons = byRole("button");

	test("first, last, nth", () => {
		expect(ids(queryResolver.resolve({ kind: "index", source: buttons, index: "first" }, index))).toEqual([
			"sign-in-submit",
		]);
		expect(ids(queryResolver.resolve({ kind: "index", source: buttons, index: "last" }, index))).toEqual(["save"]);
		expect(ids(queryResolver.resolve({ kind: "index", source: buttons, index: 2 }, index))).toEqual(["void-1"]);
	});

	test("out of range or empty source yields nothing", () => {
		expect(queryResolver.resolve({ kind: "index", source: buttons, index: 9 }, index)).toEqual([]);
		expect(queryResolver.resolve({ kind: "index", source: byRole("tab"), index: "last" }, index)).toEqual([]);
		expect(queryResolver.resolve({ kind: "index", source: byRole("tab"), index: "first" }, index)).toEqual([]);
	});

	test("first of the visible matches", () => {
		const first = {
			kind: "index",
			source: byText("No memories yet", true, true),
			index: "first",
		} satisfies LocatorExpression;
		expect(ids(queryResolver.resolve(first, index))).toEqual(["empty-shown"]);
	});
});

describe("selector queries", () => {
	const index = screen();
	const run = (text: string) => {
		const result = selectorEngine.parseSelector(text);
		if (!result.success) throw new Error(result.error);
		return queryResolver.resolve(selectorEngine.selectorToQuery(result.data), index);
	};

	test("terms and nth", () => {
		expect(ids(run("id=sign-in-submit role=button"))).toEqual(["sign-in-submit"]);
		expect(ids(run("role=button label=void nth=1"))).toEqual(["void-2"]);
		expect(run("role=button nth=20")).toEqual([]);
	});

	test("selectors are not innermost-filtered", () => {
		expect(ids(run("label=Welcome"))).toEqual(["greeting-host", "greeting"]);
	});
});

describe("exactlyOne", () => {
	const index = screen();

	test("one match is returned", () => {
		const result = queryResolver.exactlyOne(
			query({ kind: "testId", value: "email" }),
			queryResolver.resolve(query({ kind: "testId", value: "email" }), index)
		);
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.element.identifier).toBe("email");
	});

	test("zero matches is LOCATOR_NOT_FOUND with the screen text", () => {
		const expr = byText("Nope");
		const result = queryResolver.exactlyOne(expr, queryResolver.resolve(expr, index), { screen: "TREE" });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.code).toBe("LOCATOR_NOT_FOUND");
			expect(result.error.message).toContain('getByText("Nope")');
			expect(result.error.screen).toBe("TREE");
		}
	});

	test("several matches is LOCATOR_AMBIGUOUS and says how many and which", () => {
		const expr = byText("Void");
		const result = queryResolver.exactlyOne(expr, queryResolver.resolve(expr, index));
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.code).toBe("LOCATOR_AMBIGUOUS");
			if (result.error.code === "LOCATOR_AMBIGUOUS") expect(result.error.matches).toBe(2);
			expect(result.error.message).toContain("2 elements");
			expect(result.error.message).toContain("void-1");
			expect(result.error.message).toContain("void-2");
		}
	});

	test("long ambiguity lists are capped", () => {
		const expr = byRole("text");
		const matches = queryResolver.resolve(expr, index);
		expect(matches.length).toBeGreaterThan(5);
		const result = queryResolver.exactlyOne(expr, matches);
		if (!result.success) expect(result.error.message).toMatch(/\.\.\. and \d+ more/);
	});
});

describe("describeExpression", () => {
	test("reads like the spec API", () => {
		expect(queryResolver.describeExpression(byText("Sign in"))).toBe('getByText("Sign in")');
		expect(queryResolver.describeExpression(byText("sign", false, true))).toBe(
			'getByText("sign", { exact: false, visible: true })'
		);
		expect(queryResolver.describeExpression(query({ kind: "testId", value: /^row-/ }))).toBe("getByTestId(/^row-/)");
		expect(queryResolver.describeExpression(byRole("button", { name: "Save", checked: true }))).toBe(
			'getByRole("button", "Save", { checked: true })'
		);
		expect(queryResolver.describeExpression(query({ kind: "label", value: "Email" }))).toBe('getByLabel("Email")');
		expect(queryResolver.describeExpression(query({ kind: "placeholder", value: "p" }))).toBe('getByPlaceholder("p")');
		expect(queryResolver.describeExpression(query({ kind: "value", value: "v" }))).toBe('getByValue("v")');
	});

	test("chains", () => {
		const list = query({ kind: "testId", value: "invoices" });
		const chained: LocatorExpression = {
			kind: "index",
			index: "first",
			source: { kind: "filter", hasText: "42", source: query({ kind: "role", role: "button" }, list) },
		};
		expect(queryResolver.describeExpression(chained)).toBe(
			'getByTestId("invoices").getByRole("button").filter({ hasText: "42" }).first()'
		);
		expect(queryResolver.describeExpression({ kind: "index", index: 3, source: list })).toBe(
			'getByTestId("invoices").nth(3)'
		);
		expect(queryResolver.describeExpression({ kind: "filter", source: list, has: byText("x") })).toBe(
			'getByTestId("invoices").filter({ has: getByText("x") })'
		);
	});

	test("selectors", () => {
		const result = selectorEngine.parseSelector("id=a role=button nth=1");
		if (!result.success) throw new Error(result.error);
		expect(queryResolver.describeExpression(selectorEngine.selectorToQuery(result.data))).toBe(
			'locator("id=a role=button").nth(1)'
		);
	});
});
