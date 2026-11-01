import { err, ok, type Result } from "@delacour/warden-types/result";
import type { NodeEntry } from "./nodes";
import type { LocatorExpression } from "./query";
import { matchesText, normalizeText } from "./text";

/** A selector value: literal text (bare or quoted on the wire) or a regular expression. */
export type SelectorValue = { kind: "text"; value: string } | { kind: "regex"; source: string; flags: string };

/**
 * The agent-CLI selector grammar: `id=<v> label=<v> text=<v> role=<v> value=<v> editable=true|false nth=<i>`.
 * `id` is exact; `label`, `text` and `value` are case-insensitive substrings; a regex is applied as written.
 */
export type ParsedSelector = {
	id?: SelectorValue;
	label?: SelectorValue;
	text?: SelectorValue;
	role?: SelectorValue;
	value?: SelectorValue;
	editable?: boolean;
	nth?: number;
};

const VALUE_KEYS = ["id", "label", "text", "role", "value"] as const;
const KEY_ORDER = [...VALUE_KEYS, "editable", "nth"] as const;
type SelectorKey = (typeof KEY_ORDER)[number];
type ValueKey = (typeof VALUE_KEYS)[number];

const REGEX_FLAGS = /^[dgimsuvy]*$/;

function isSpace(char: string | undefined): boolean {
	return char === undefined || /\s/.test(char);
}

type Token = { key: string; raw: string; value: SelectorValue };

function readQuoted(input: string, start: number): Result<{ value: string; end: number }> {
	let end = start + 1;
	while (end < input.length && input[end] !== '"') end += input[end] === "\\" ? 2 : 1;
	if (end >= input.length) return err("unterminated quoted value");
	const literal = input.slice(start, end + 1);
	try {
		const value: unknown = JSON.parse(literal);
		if (typeof value !== "string") return err(`invalid escape in ${literal}`);
		return ok({ value, end: end + 1 });
	} catch {
		return err(`invalid escape in ${literal}`);
	}
}

function readRegex(input: string, start: number): Result<{ value: SelectorValue; end: number }> {
	let end = start + 1;
	while (end < input.length && input[end] !== "/") end += input[end] === "\\" ? 2 : 1;
	if (end >= input.length) return err("unterminated regex value");
	const source = input.slice(start + 1, end);
	if (source === "") return err("empty regex //");
	let flagsEnd = end + 1;
	while (flagsEnd < input.length && !isSpace(input[flagsEnd])) flagsEnd += 1;
	const flags = input.slice(end + 1, flagsEnd);
	try {
		if (!REGEX_FLAGS.test(flags)) throw new Error("bad flags");
		new RegExp(source, flags);
	} catch {
		return err(`invalid regex /${source}/${flags}`);
	}
	return ok({ value: { kind: "regex", source, flags }, end: flagsEnd });
}

function readValue(input: string, start: number, key: string): Result<{ value: SelectorValue; end: number }> {
	const first = input[start];
	if (isSpace(first)) return err(`missing value for ${key}=`);
	if (first === '"') {
		const quoted = readQuoted(input, start);
		if (!quoted.success) return quoted;
		if (!isSpace(input[quoted.data.end])) return err(`unexpected text after quoted value of ${key}=`);
		return ok({ value: { kind: "text", value: quoted.data.value }, end: quoted.data.end });
	}
	if (first === "/") return readRegex(input, start);
	let end = start;
	while (!isSpace(input[end])) end += 1;
	return ok({ value: { kind: "text", value: input.slice(start, end) }, end });
}

function tokenize(input: string): Result<Token[]> {
	const tokens: Token[] = [];
	let position = 0;
	for (;;) {
		while (position < input.length && isSpace(input[position])) position += 1;
		if (position >= input.length) return ok(tokens);
		const equals = input.indexOf("=", position);
		let wordEnd = position;
		while (!isSpace(input[wordEnd])) wordEnd += 1;
		if (equals === -1 || equals > wordEnd) return err(`expected key=value, got "${input.slice(position, wordEnd)}"`);
		const key = input.slice(position, equals);
		const read = readValue(input, equals + 1, key);
		if (!read.success) return read;
		tokens.push({ key, raw: input.slice(position, read.data.end), value: read.data.value });
		position = read.data.end;
	}
}

function isSelectorKey(key: string): key is SelectorKey {
	return (KEY_ORDER as readonly string[]).includes(key);
}

function isValueKey(key: SelectorKey): key is ValueKey {
	return (VALUE_KEYS as readonly string[]).includes(key);
}

/** Parses `id=x label="Sign in" text=/regex/i role=button editable=true nth=1`. */
export function parseSelector(input: string): Result<ParsedSelector> {
	if (input.trim() === "") return err("empty selector");
	const tokens = tokenize(input);
	if (!tokens.success) return tokens;
	const selector: ParsedSelector = {};
	const seen = new Set<string>();
	for (const token of tokens.data) {
		if (!isSelectorKey(token.key)) {
			return err(`unknown key "${token.key}" (expected ${KEY_ORDER.join(", ")})`);
		}
		if (seen.has(token.key)) return err(`duplicate key "${token.key}"`);
		seen.add(token.key);
		const failure = applyToken(selector, token.key, token);
		if (failure !== undefined) return err(failure);
	}
	return ok(selector);
}

/** Stores one token on the selector; returns the error message when its value is not valid for the key. */
function applyToken(selector: ParsedSelector, key: SelectorKey, token: Token): string | undefined {
	if (isValueKey(key)) {
		selector[key] = token.value;
		return undefined;
	}
	const word = token.value.kind === "text" ? token.value.value : "";
	if (key === "editable") {
		if (word !== "true" && word !== "false") return `editable must be true or false, got ${token.raw}`;
		selector.editable = word === "true";
		return undefined;
	}
	if (!/^\d+$/.test(word)) return `nth must be a non-negative integer, got ${token.raw}`;
	selector.nth = Number(word);
	return undefined;
}

function formatValue(value: SelectorValue): string {
	if (value.kind === "regex") return `/${value.source}/${value.flags}`;
	return /^[^\s"/][^\s]*$/.test(value.value) ? value.value : JSON.stringify(value.value);
}

/** The canonical text for a selector; `parseSelector(formatSelector(s))` equals `s`. */
export function formatSelector(selector: ParsedSelector): string {
	const parts: string[] = [];
	for (const key of VALUE_KEYS) {
		const value = selector[key];
		if (value !== undefined) parts.push(`${key}=${formatValue(value)}`);
	}
	if (selector.editable !== undefined) parts.push(`editable=${selector.editable}`);
	if (selector.nth !== undefined) parts.push(`nth=${selector.nth}`);
	return parts.join(" ");
}

/** The expression a selector stands for: one selector query, wrapped in `nth` when given. */
export function selectorToQuery(selector: ParsedSelector): LocatorExpression {
	const { nth, ...rest } = selector;
	const base: LocatorExpression = { kind: "query", query: { kind: "selector", selector: rest } };
	return nth === undefined ? base : { kind: "index", source: base, index: nth };
}

function matchesValue(actual: string | undefined, value: SelectorValue, mode: "exact" | "substring"): boolean {
	if (actual === undefined) return false;
	if (value.kind === "regex") return matchesText(actual, new RegExp(value.source, value.flags));
	if (mode === "exact") return actual === value.value;
	return matchesText(actual, value.value, { exact: false });
}

function kebabType(rawType: string): string {
	const simple = rawType.slice(rawType.lastIndexOf(".") + 1);
	return simple
		.replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replaceAll(/[\s_]+/g, "-")
		.toLowerCase();
}

function roleNames(entry: NodeEntry): string[] {
	return [entry.role, entry.element.role, kebabType(entry.element.rawType), entry.element.rawType.toLowerCase()];
}

function matchesRole(entry: NodeEntry, value: SelectorValue): boolean {
	const names = roleNames(entry);
	if (value.kind === "regex") return names.some((name) => matchesValue(name, value, "exact"));
	const wanted = value.value.toLowerCase().replaceAll(/[\s_]+/g, "-");
	return names.some((name) => name === wanted || name.replaceAll("-", "") === wanted.replaceAll("-", ""));
}

function textCandidates(entry: NodeEntry): (string | undefined)[] {
	return [entry.element.label, entry.element.text, entry.value];
}

/** One node against one parsed selector (`nth` is not part of matching; see `selectorToQuery`). */
export function matchesSelector(entry: NodeEntry, selector: ParsedSelector): boolean {
	if (selector.id !== undefined && !matchesValue(entry.element.identifier, selector.id, "exact")) return false;
	if (selector.label !== undefined && !matchesValue(entry.name, selector.label, "substring")) return false;
	if (selector.text !== undefined) {
		const wanted = selector.text;
		if (!textCandidates(entry).some((candidate) => matchesValue(candidate, wanted, "substring"))) return false;
	}
	if (selector.value !== undefined && !matchesValue(entry.value, selector.value, "substring")) return false;
	if (selector.role !== undefined && !matchesRole(entry, selector.role)) return false;
	if (selector.editable !== undefined) {
		const editable = entry.role === "textbox" || entry.role === "searchbox";
		if (editable !== selector.editable) return false;
	}
	return true;
}

function exactTerms(entry: NodeEntry, selector: ParsedSelector): number {
	let count = 0;
	const same = (actual: string | undefined, value: SelectorValue | undefined): boolean =>
		value !== undefined &&
		(value.kind === "regex"
			? matchesValue(actual, value, "exact")
			: actual !== undefined && normalizeText(actual).toLowerCase() === normalizeText(value.value).toLowerCase());
	if (same(entry.name, selector.label)) count += 1;
	if (same(entry.value, selector.value)) count += 1;
	if (selector.text !== undefined && textCandidates(entry).some((candidate) => same(candidate, selector.text)))
		count += 1;
	return count;
}

function area(entry: NodeEntry): number {
	return entry.element.frame.width * entry.element.frame.height;
}

/**
 * Picks the target of an action among several matches: visible first, then the most exact text terms, then the smallest
 * frame, then reading order.
 */
export function pickMostSpecific(matches: readonly NodeEntry[], selector: ParsedSelector): NodeEntry | undefined {
	const visible = matches.filter((entry) => entry.visible);
	const pool = visible.length > 0 ? visible : matches;
	let best: NodeEntry | undefined;
	for (const entry of pool) {
		if (best === undefined) {
			best = entry;
			continue;
		}
		const exactDelta = exactTerms(entry, selector) - exactTerms(best, selector);
		if (exactDelta > 0 || (exactDelta === 0 && area(entry) < area(best))) best = entry;
	}
	return best;
}
