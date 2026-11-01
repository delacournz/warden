import { E2eError } from "@delacour/warden-driver/e2e-error";
import type { LocatorExpression, Query, RoleQuery } from "./query";
import { QUERY_ROLES, type QueryRole, roleResolver } from "./roles";
import { selectorEngine } from "./selector";
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

const METHOD = {
	text: "getByText",
	label: "getByLabel",
	placeholder: "getByPlaceholder",
	value: "getByValue",
} as const;

export class QueryBuilder {
	/** An option key the query does not take is a typo: `INVALID_LOCATOR` naming the keys it does. */
	private assertKeys(method: string, options: object, allowed: readonly string[]): void {
		const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
		if (unknown.length > 0) {
			throw new E2eError(
				"INVALID_LOCATOR",
				`${method} does not take ${unknown.map((key) => `"${key}"`).join(", ")}; it takes ${allowed.join(", ")}`
			);
		}
	}

	/** Copies the keys that are set, so queries never carry `undefined` options. */
	private defined<T extends object>(source: T): T {
		return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as T;
	}

	testIdQuery(id: TextMatch, options: TestIdOptions = {}): Query {
		this.assertKeys("getByTestId", options, TEST_ID_KEYS);
		return { kind: "testId", value: id, ...this.defined(options) };
	}

	textQuery(kind: keyof typeof METHOD, value: TextMatch, options: TextQueryOptions = {}): Query {
		this.assertKeys(METHOD[kind], options, TEXT_KEYS);
		return { kind, value, ...this.defined(options) };
	}

	private isRoleOptions(value: TextMatch | RoleOptions | undefined): value is RoleOptions {
		return value !== undefined && typeof value === "object" && !(value instanceof RegExp);
	}

	/** `getByRole("button", "Save", { checked })` and `getByRole("button", { name: "Save", checked })` are the same query. */
	roleQuery(
		role: QueryRole,
		nameOrOptions?: TextMatch | RoleOptions,
		options: Omit<RoleOptions, "name"> = {}
	): RoleQuery {
		if (!roleResolver.isQueryRole(role)) {
			throw new E2eError(
				"INVALID_LOCATOR",
				`getByRole does not know the role "${String(role)}"; use one of ${QUERY_ROLES.join(", ")}`
			);
		}
		const merged: RoleOptions = this.isRoleOptions(nameOrOptions)
			? { ...nameOrOptions, ...options }
			: { ...(nameOrOptions === undefined ? {} : { name: nameOrOptions }), ...options };
		this.assertKeys("getByRole", merged, ROLE_KEYS);
		return { kind: "role", role, ...this.defined(merged) };
	}

	/** `locator("id=x role=button")`: the agent-CLI selector grammar as a locator expression. */
	selectorExpression(text: string): LocatorExpression {
		const parsed = selectorEngine.parseSelector(text);
		if (!parsed.success)
			throw new E2eError("INVALID_LOCATOR", `invalid selector ${JSON.stringify(text)}: ${parsed.error}`);
		return selectorEngine.selectorToQuery(parsed.data);
	}

	/** Runs `expr` inside the subtree(s) of `scope` (below any scope `expr` already has). */
	withScope(expr: LocatorExpression, scope: LocatorExpression): LocatorExpression {
		switch (expr.kind) {
			case "query":
				return {
					kind: "query",
					query: expr.query,
					scope: expr.scope === undefined ? scope : this.withScope(expr.scope, scope),
				};
			case "filter":
				return { ...expr, source: this.withScope(expr.source, scope) };
			case "index":
				return { ...expr, source: this.withScope(expr.source, scope) };
		}
	}
}

export const queryBuilder = new QueryBuilder();
