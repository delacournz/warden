import { E2eError } from "../errors";
import type { LocatorExpression, Query, RoleQuery } from "./query";
import { isQueryRole, QUERY_ROLES, type QueryRole } from "./roles";
import { parseSelector, selectorToQuery } from "./selector";
import type { TextMatch } from "./text";

/** Pure constructors for the `getBy*` family, shared by `screen` and `Locator` (which scopes them to its subtree). */

export type TextQueryOptions = { exact?: boolean; visible?: boolean };
export type TestIdOptions = { visible?: boolean };
export type RoleOptions = {
	name?: TextMatch;
	exact?: boolean;
	checked?: boolean;
	disabled?: boolean;
	selected?: boolean;
	visible?: boolean;
};

const TEXT_KEYS = ["exact", "visible"] as const;
const TEST_ID_KEYS = ["visible"] as const;
const ROLE_KEYS = ["name", "exact", "checked", "disabled", "selected", "visible"] as const;

/** An option key the query does not take is a typo: `INVALID_LOCATOR` naming the keys it does. */
function assertKeys(method: string, options: object, allowed: readonly string[]): void {
	const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) {
		throw new E2eError(
			"INVALID_LOCATOR",
			`${method} does not take ${unknown.map((key) => `"${key}"`).join(", ")}; it takes ${allowed.join(", ")}`
		);
	}
}

/** Copies the keys that are set, so queries never carry `undefined` options. */
function defined<T extends object>(source: T): T {
	return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as T;
}

export function testIdQuery(id: TextMatch, options: TestIdOptions = {}): Query {
	assertKeys("getByTestId", options, TEST_ID_KEYS);
	return { kind: "testId", value: id, ...defined(options) };
}

const METHOD = {
	text: "getByText",
	label: "getByLabel",
	placeholder: "getByPlaceholder",
	value: "getByValue",
} as const;

export function textQuery(kind: keyof typeof METHOD, value: TextMatch, options: TextQueryOptions = {}): Query {
	assertKeys(METHOD[kind], options, TEXT_KEYS);
	return { kind, value, ...defined(options) };
}

function isRoleOptions(value: TextMatch | RoleOptions | undefined): value is RoleOptions {
	return value !== undefined && typeof value === "object" && !(value instanceof RegExp);
}

/** `getByRole("button", "Save", { checked })` and `getByRole("button", { name: "Save", checked })` are the same query. */
export function roleQuery(
	role: QueryRole,
	nameOrOptions?: TextMatch | RoleOptions,
	options: Omit<RoleOptions, "name"> = {}
): RoleQuery {
	if (!isQueryRole(role)) {
		throw new E2eError(
			"INVALID_LOCATOR",
			`getByRole does not know the role "${String(role)}"; use one of ${QUERY_ROLES.join(", ")}`
		);
	}
	const merged: RoleOptions = isRoleOptions(nameOrOptions)
		? { ...nameOrOptions, ...options }
		: { ...(nameOrOptions === undefined ? {} : { name: nameOrOptions }), ...options };
	assertKeys("getByRole", merged, ROLE_KEYS);
	return { kind: "role", role, ...defined(merged) };
}

/** `locator("id=x role=button")`: the agent-CLI selector grammar as a locator expression. */
export function selectorExpression(text: string): LocatorExpression {
	const parsed = parseSelector(text);
	if (!parsed.success)
		throw new E2eError("INVALID_LOCATOR", `invalid selector ${JSON.stringify(text)}: ${parsed.error}`);
	return selectorToQuery(parsed.data);
}

/** Runs `expr` inside the subtree(s) of `scope` (below any scope `expr` already has). */
export function withScope(expr: LocatorExpression, scope: LocatorExpression): LocatorExpression {
	switch (expr.kind) {
		case "query":
			return {
				kind: "query",
				query: expr.query,
				scope: expr.scope === undefined ? scope : withScope(expr.scope, scope),
			};
		case "filter":
			return { ...expr, source: withScope(expr.source, scope) };
		case "index":
			return { ...expr, source: withScope(expr.source, scope) };
	}
}
