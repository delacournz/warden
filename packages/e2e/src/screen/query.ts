import { ok, type Result } from "@delacour/warden-types/result";
import { type E2eError, e2eErr } from "../errors";
import { descendantsOf, isWithin, type NodeEntry, type NodeIndex } from "./nodes";
import { describeEntry } from "./render";
import type { QueryRole } from "./roles";
import { formatSelector, matchesSelector, type ParsedSelector } from "./selector";
import { matchesText, type TextMatch } from "./text";

/** Every query accepts `visible: true`, which drops hidden nodes before the exactly-one rule runs. */
type Visibility = { visible?: boolean };

export type RoleQuery = {
	kind: "role";
	role: QueryRole;
	name?: TextMatch;
	exact?: boolean;
	checked?: boolean;
	disabled?: boolean;
	selected?: boolean;
} & Visibility;

export type Query =
	| ({ kind: "testId"; value: TextMatch } & Visibility)
	| ({ kind: "text" | "label" | "placeholder" | "value"; value: TextMatch; exact?: boolean } & Visibility)
	| RoleQuery
	| ({ kind: "selector"; selector: ParsedSelector } & Visibility);

/**
 * A lazy locator: what to look for, never where it is. Evaluated against one `NodeIndex` by `resolve`.
 * `query` optionally runs inside the subtree(s) of `scope`; `filter` refines; `index` picks one.
 */
export type LocatorExpression =
	| { kind: "query"; query: Query; scope?: LocatorExpression }
	| { kind: "filter"; source: LocatorExpression; hasText?: TextMatch; has?: LocatorExpression }
	| { kind: "index"; source: LocatorExpression; index: "first" | "last" | number };

function textOptions(exact: boolean | undefined): { exact: boolean } {
	return { exact: exact ?? true };
}

function matchesQuery(entry: NodeEntry, query: Query): boolean {
	if (query.kind === "role") return matchesRoleQuery(entry, query);
	if (query.visible === true && entry.states.hidden) return false;
	switch (query.kind) {
		case "testId": {
			const id = entry.element.identifier;
			return id !== undefined && id !== "" && matchesText(id, query.value);
		}
		case "text": {
			const options = textOptions(query.exact);
			return [entry.element.label, entry.element.text].some(
				(text) => text !== undefined && text !== "" && matchesText(text, query.value, options)
			);
		}
		case "label":
			return entry.name !== undefined && matchesText(entry.name, query.value, textOptions(query.exact));
		case "placeholder": {
			const placeholder = entry.element.placeholder;
			return placeholder !== undefined && matchesText(placeholder, query.value, textOptions(query.exact));
		}
		case "value":
			return entry.value !== undefined && matchesText(entry.value, query.value, textOptions(query.exact));
		case "selector":
			return matchesSelector(entry, query.selector);
	}
}

function matchesRoleQuery(entry: NodeEntry, query: RoleQuery): boolean {
	if (entry.role !== query.role || entry.states.hidden) return false;
	if (query.name !== undefined && !matchesText(entry.name ?? "", query.name, textOptions(query.exact))) return false;
	if (query.checked !== undefined && (entry.states.checked ?? false) !== query.checked) return false;
	if (query.disabled !== undefined && entry.states.disabled !== query.disabled) return false;
	if (query.selected !== undefined && entry.states.selected !== query.selected) return false;
	return true;
}

/** text and label echo up the tree on a device (RN host views, containers inheriting labels): keep the innermost. */
const ECHOED_KINDS: ReadonlySet<Query["kind"]> = new Set<Query["kind"]>(["text", "label"]);

function innermostOnly(matches: NodeEntry[]): NodeEntry[] {
	const matched = new Set(matches);
	return matches.filter((entry) => {
		for (const other of matched) {
			if (other !== entry && isWithin(other, entry)) return false;
		}
		return true;
	});
}

function subtreeHasText(entry: NodeEntry, hasText: TextMatch): boolean {
	const options = { exact: false };
	return (
		entry.fragments.some((fragment) => matchesText(fragment, hasText, options)) ||
		matchesText(entry.subtreeText, hasText, options)
	);
}

function evaluate(expr: LocatorExpression, universe: readonly NodeEntry[]): NodeEntry[] {
	switch (expr.kind) {
		case "query": {
			const candidates = expr.scope === undefined ? universe : descendantsOf(universe, evaluate(expr.scope, universe));
			const matches = candidates.filter((entry) => matchesQuery(entry, expr.query));
			return ECHOED_KINDS.has(expr.query.kind) ? innermostOnly(matches) : matches;
		}
		case "filter":
			return evaluate(expr.source, universe).filter((entry) => {
				if (expr.hasText !== undefined && !subtreeHasText(entry, expr.hasText)) return false;
				if (expr.has !== undefined && evaluate(expr.has, descendantsOf(universe, [entry])).length === 0) return false;
				return true;
			});
		case "index": {
			const source = evaluate(expr.source, universe);
			const position = expr.index === "first" ? 0 : expr.index === "last" ? source.length - 1 : expr.index;
			const picked = source[position];
			return picked === undefined ? [] : [picked];
		}
	}
}

/** Every node the expression currently matches, in document order. One immediate pass: no waiting, no strictness. */
export function resolve(expr: LocatorExpression, index: NodeIndex): NodeEntry[] {
	return evaluate(expr, index.entries);
}

const MAX_LISTED = 5;

/**
 * The strict one-match rule for actions and reads: zero matches is `LOCATOR_NOT_FOUND`, several is `LOCATOR_AMBIGUOUS`.
 * `options.screen` is attached to the error (the rendered tree helps a failure report).
 */
export function exactlyOne(
	expr: LocatorExpression,
	matches: readonly NodeEntry[],
	options: { screen?: string } = {}
): Result<NodeEntry, E2eError> {
	const screen = options.screen === undefined ? {} : { screen: options.screen };
	const [first] = matches;
	if (first === undefined) {
		return e2eErr({ code: "LOCATOR_NOT_FOUND", message: `${describeExpression(expr)} matched no elements`, ...screen });
	}
	if (matches.length === 1) return ok(first);
	const listed = matches.slice(0, MAX_LISTED).map((entry) => `  ${describeEntry(entry)}`);
	if (matches.length > MAX_LISTED) listed.push(`  ... and ${matches.length - MAX_LISTED} more`);
	return e2eErr({
		code: "LOCATOR_AMBIGUOUS",
		message: `${describeExpression(expr)} matched ${matches.length} elements:\n${listed.join("\n")}`,
		matches: matches.length,
		...screen,
	});
}

function describeMatch(match: TextMatch): string {
	return typeof match === "string" ? JSON.stringify(match) : String(match);
}

function describeOptions(options: [string, unknown][]): string {
	const present = options.filter(([, value]) => value !== undefined);
	return present.length === 0 ? "" : `{ ${present.map(([key, value]) => `${key}: ${String(value)}`).join(", ")} }`;
}

function describeQuery(query: Query): string {
	switch (query.kind) {
		case "testId":
			return `getByTestId(${[describeMatch(query.value), describeOptions([["visible", query.visible]])].filter(Boolean).join(", ")})`;
		case "role": {
			const options = describeOptions([
				["exact", query.exact],
				["checked", query.checked],
				["disabled", query.disabled],
				["selected", query.selected],
				["visible", query.visible],
			]);
			const args = [
				JSON.stringify(query.role),
				query.name === undefined ? "" : describeMatch(query.name),
				options,
			].filter(Boolean);
			return `getByRole(${args.join(", ")})`;
		}
		case "selector":
			return `locator(${JSON.stringify(formatSelector(query.selector))})`;
		case "text":
		case "label":
		case "placeholder":
		case "value": {
			const method = { text: "getByText", label: "getByLabel", placeholder: "getByPlaceholder", value: "getByValue" }[
				query.kind
			];
			const options = describeOptions([
				["exact", query.exact],
				["visible", query.visible],
			]);
			return `${method}(${[describeMatch(query.value), options].filter(Boolean).join(", ")})`;
		}
	}
}

/** A spec-API style description of the expression (`getByRole("button", "Save").first()`), for error messages. */
export function describeExpression(expr: LocatorExpression): string {
	switch (expr.kind) {
		case "query":
			return expr.scope === undefined
				? describeQuery(expr.query)
				: `${describeExpression(expr.scope)}.${describeQuery(expr.query)}`;
		case "filter": {
			const parts = [
				expr.hasText === undefined ? "" : `hasText: ${describeMatch(expr.hasText)}`,
				expr.has === undefined ? "" : `has: ${describeExpression(expr.has)}`,
			].filter(Boolean);
			return `${describeExpression(expr.source)}.filter({ ${parts.join(", ")} })`;
		}
		case "index": {
			const source = describeExpression(expr.source);
			if (expr.index === "first") return `${source}.first()`;
			if (expr.index === "last") return `${source}.last()`;
			return `${source}.nth(${expr.index})`;
		}
	}
}
