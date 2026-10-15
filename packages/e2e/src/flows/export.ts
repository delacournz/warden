import { isQueryRole } from "../screen/roles";
import { type ParsedSelector, parseSelector, type SelectorValue } from "../screen/selector";
import type { Flow, SelectorTarget, Step, StepOf, Target, Text } from "./flow.schema";
import { SECRET_PREFIX } from "./record";

/**
 * Export: turn a recorded flow into a `*.e2e.ts` spec for `@delacour/warden-e2e`. Pure text generation: the same flow
 * always yields the same file, so the output is reviewable and golden-testable. Selectors become `getBy*` locators
 * (test ids go through an `ids` map), `wait`/`is` become `expect` matchers, and anything the spec API cannot express
 * (coordinates other than a tap, untargeted typing) is a loud `FIXME` that throws instead of passing silently.
 */

export type ExportOptions = {
	/** known test ids, `{ key: testId }`; keys are reused, new test ids get a generated camelCase key */
	ids?: Record<string, string>;
	/** import the ids map from this module instead of declaring it inline */
	idsImport?: string;
	/** where `test`/`expect` come from. Default `@delacour/warden-e2e`. */
	importFrom?: string;
};

export type ExportResult = {
	spec: string;
	/** every id the spec uses plus the ones passed in, `{ key: testId }` */
	ids: Record<string, string>;
};

const DEFAULT_IMPORT = "@delacour/warden-e2e";
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const lit = (value: string): string => JSON.stringify(value);

/** `sign-in-submit` → `signInSubmit`; always a valid identifier. */
export function idKey(testId: string): string {
	const words = testId.split(/[^A-Za-z0-9]+/).filter((word) => word !== "");
	const [first = "id", ...rest] = words;
	const joined = [
		first.charAt(0).toLowerCase() + first.slice(1),
		...rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1)),
	].join("");
	return /^[0-9]/.test(joined) ? `id${joined.charAt(0).toUpperCase()}${joined.slice(1)}` : joined;
}

/** The ids map while a spec is generated: provided keys win, new test ids get `idKey` (suffixed on a clash). */
class IdRegistry {
	private readonly byKey = new Map<string, string>();
	private readonly byValue = new Map<string, string>();
	private readonly added: string[] = [];

	constructor(known: Record<string, string>) {
		for (const [key, testId] of Object.entries(known)) {
			this.byKey.set(key, testId);
			if (!this.byValue.has(testId)) this.byValue.set(testId, key);
		}
	}

	keyFor(testId: string): string {
		const existing = this.byValue.get(testId);
		if (existing !== undefined) return existing;
		const base = idKey(testId);
		let key = base;
		for (let n = 2; this.byKey.has(key); n += 1) key = `${base}${n}`;
		this.byKey.set(key, testId);
		this.byValue.set(testId, key);
		this.added.push(key);
		return key;
	}

	get size(): number {
		return this.byKey.size;
	}

	get newKeys(): readonly string[] {
		return this.added;
	}

	toObject(): Record<string, string> {
		return Object.fromEntries(this.byKey);
	}
}

type Uses = { app: boolean; device: boolean; screen: boolean; expect: boolean; ids: boolean };

type Gen = {
	registry: IdRegistry;
	uses: Uses;
	/** secret name → variable holding its value */
	secrets: Map<string, string>;
};

// ---- selectors → locators ---------------------------------------------------------------------------------------

function onlyText(value: SelectorValue | undefined): string | undefined {
	return value?.kind === "text" ? value.value : undefined;
}

type Terms = Omit<ParsedSelector, "nth">;
type TermKey = "id" | "label" | "text" | "role" | "value";
const TERM_KEYS: readonly TermKey[] = ["id", "label", "text", "role", "value"];

function idLocator(testId: string, gen: Gen): string {
	gen.uses.ids = true;
	const key = gen.registry.keyFor(testId);
	return `screen.getByTestId(${IDENTIFIER.test(key) ? `ids.${key}` : `ids[${lit(key)}]`})`;
}

function roleLocator(role: string | undefined, name: string | undefined): string | undefined {
	if (role === undefined || !isQueryRole(role)) return undefined;
	return `screen.${call("getByRole", lit(role), name === undefined ? "" : lit(name))}`;
}

/** The `getBy*` call for a selector's terms, or undefined when only `screen.locator(...)` can say it. */
function baseLocator(terms: Terms, gen: Gen): string | undefined {
	if (terms.editable !== undefined) return undefined;
	const texts: Partial<Record<TermKey, string>> = {};
	for (const key of TERM_KEYS) {
		const value = onlyText(terms[key]);
		if (terms[key] !== undefined && value === undefined) return undefined;
		if (value !== undefined) texts[key] = value;
	}
	const { id, label, text, role, value } = texts;
	const shape = TERM_KEYS.filter((key) => texts[key] !== undefined).join("+");
	switch (shape) {
		case "id":
			return id === undefined ? undefined : idLocator(id, gen);
		case "label":
			return `screen.getByLabel(${lit(label ?? "")})`;
		case "text":
			return `screen.getByText(${lit(text ?? "")})`;
		case "value":
			return `screen.getByValue(${lit(value ?? "")})`;
		case "role":
			return roleLocator(role, undefined);
		case "label+role":
			return roleLocator(role, label);
		case "text+role":
			return roleLocator(role, text);
		default:
			return undefined;
	}
}

function locatorOf(target: SelectorTarget, gen: Gen): string {
	gen.uses.screen = true;
	const parsed = parseSelector(target.selector);
	if (!parsed.success) return `screen.locator(${lit(target.selector)})`;
	const { nth, ...terms } = parsed.data;
	const base = baseLocator(terms, gen);
	if (base === undefined) return `screen.locator(${lit(target.selector)})`;
	return nth === undefined ? base : `${base}.nth(${nth})`;
}

// ---- values -----------------------------------------------------------------------------------------------------

function camel(name: string): string {
	return idKey(name.toLowerCase());
}

/** Literal text, or the variable that holds a `WARDEN_UI_SECRET_<NAME>` value (declared at the top of the test). */
function textOf(value: Text, gen: Gen): string {
	if (typeof value === "string") return lit(value);
	const existing = gen.secrets.get(value.secret);
	if (existing !== undefined) return existing;
	const variable = `${camel(value.secret)}Secret`;
	gen.secrets.set(value.secret, variable);
	return variable;
}

function options(pairs: [string, string | number | boolean | undefined][]): string {
	const present = pairs.filter((pair): pair is [string, string | number | boolean] => pair[1] !== undefined);
	return present.length === 0
		? ""
		: `{ ${present.map(([key, value]) => `${key}: ${typeof value === "string" ? lit(value) : value}`).join(", ")} }`;
}

/** `name(a, b)` without trailing empty arguments. */
function call(name: string, ...args: string[]): string {
	return `${name}(${args.filter((arg) => arg !== "").join(", ")})`;
}

const point = (x: number, y: number): string => `{ x: ${x}, y: ${y} }`;

// ---- steps → statements -----------------------------------------------------------------------------------------

/** A step the spec API cannot express: say so, and fail the test rather than skip the step. */
function unsupported(what: string, why: string): string[] {
	return [`// FIXME: ${why}; the spec API has no ${what}`, `throw new Error(${lit(`FIXME: ${what} (${why})`)});`];
}

/** `emit` with the locator of a selector target; a coordinate or missing target is an `unsupported` step. */
function located(target: Target | undefined, gen: Gen, what: string, emit: (locator: string) => string[]): string[] {
	if (target?.kind === "selector") return emit(locatorOf(target, gen));
	return unsupported(what, target ? "recorded by coordinates" : "recorded without a target");
}

const IS_MATCHERS = {
	visible: "toBeVisible()",
	hidden: "toBeHidden()",
	enabled: "toBeEnabled()",
	disabled: "toBeDisabled()",
	checked: "toBeChecked()",
	unchecked: "toBeChecked({ checked: false })",
} as const;

function open(step: StepOf<"open">, gen: Gen): string[] {
	if (step.app === undefined && step.url !== undefined) {
		gen.uses.device = true;
		return [`await device.openLink(${lit(step.url)});`];
	}
	gen.uses.app = true;
	const args = step.args === undefined ? undefined : `[${step.args.map(lit).join(", ")}]`;
	const pairs = [
		step.url === undefined ? "" : `url: ${lit(step.url)}`,
		args === undefined ? "" : `args: ${args}`,
	].filter(Boolean);
	return [`await ${call("app.open", pairs.length === 0 ? "" : `{ ${pairs.join(", ")} }`)};`];
}

function interaction(step: Step, gen: Gen): string[] | undefined {
	switch (step.kind) {
		case "press": {
			if (step.target.kind === "selector") return [`await ${locatorOf(step.target, gen)}.tap();`];
			gen.uses.screen = true;
			return [
				`// FIXME: recorded by coordinates (${step.target.warning})`,
				`await screen.tapAt(${point(step.target.x, step.target.y)});`,
			];
		}
		case "longpress":
			return located(step.target, gen, "long press at a point", (l) => [
				`await ${l}.${call("longPress", options([["durationMs", step.durationMs]]))};`,
			]);
		case "fill":
			return located(step.target, gen, "fill without an element", (l) => [
				`await ${l}.fill(${textOf(step.text, gen)});`,
			]);
		case "type":
			return located(step.target, gen, "typing without a target field", (l) => [
				`await ${l}.type(${textOf(step.text, gen)});`,
			]);
		case "key": {
			const modifiers = step.modifiers?.length ? `{ modifiers: [${step.modifiers.map(lit).join(", ")}] }` : "";
			return located(step.target, gen, "key press without a target field", (l) => [
				`await ${l}.${call("press", lit(step.key), modifiers)};`,
			]);
		}
		default:
			return undefined;
	}
}

function gestures(step: Step, gen: Gen): string[] | undefined {
	switch (step.kind) {
		case "swipe": {
			if (step.gesture.by === "path") {
				gen.uses.screen = true;
				const { from, to, durationMs } = step.gesture;
				const duration = durationMs === undefined ? "" : `, durationMs: ${durationMs}`;
				return [`await screen.swipe({ from: ${point(from.x, from.y)}, to: ${point(to.x, to.y)}${duration} });`];
			}
			const { direction, momentum, target } = step.gesture;
			const opts = options([
				["direction", direction],
				["momentum", momentum],
			]);
			if (target?.kind === "selector") return [`await ${locatorOf(target, gen)}.swipe(${opts});`];
			gen.uses.screen = true;
			return [
				...(target ? [`// FIXME: swipe target was recorded by coordinates (${target.warning})`] : []),
				`await screen.swipe(${opts});`,
			];
		}
		case "scroll": {
			gen.uses.screen = true;
			const direction = step.direction ?? "down";
			if (step.until?.kind === "selector") {
				const opts = options([
					["direction", direction],
					["maxSwipes", step.maxSwipes],
					["timeout", step.timeoutMs],
				]);
				return [`await screen.${call("scrollUntilVisible", locatorOf(step.until, gen), opts)};`];
			}
			return [
				...(step.until ? [`// FIXME: scroll target was recorded by coordinates (${step.until.warning})`] : []),
				`await screen.swipe(${options([["direction", direction]])});`,
			];
		}
		default:
			return undefined;
	}
}

function checks(step: Step, gen: Gen): string[] | undefined {
	switch (step.kind) {
		case "wait": {
			const state = step.state ?? "visible";
			return located(step.target, gen, "wait on a point", (l) => {
				if (state === "attached" || state === "detached") {
					return [
						`await ${l}.${call(
							"waitFor",
							options([
								["state", state],
								["timeout", step.timeoutMs],
							])
						)};`,
					];
				}
				gen.uses.expect = true;
				const matcher = state === "visible" ? "toBeVisible" : "toBeHidden";
				return [`await expect(${l}).${call(matcher, options([["timeout", step.timeoutMs]]))};`];
			});
		}
		case "is":
			return located(step.target, gen, "state check on a point", (l) => {
				gen.uses.expect = true;
				return [`await expect(${l})${step.not === true ? ".not" : ""}.${IS_MATCHERS[step.state]};`];
			});
		case "get":
			return located(step.target, gen, "read from a point", (l) => {
				gen.uses.expect = true;
				return [`expect(await ${l}.${step.property}()).toBe(${textOf(step.expected, gen)});`];
			});
		default:
			return undefined;
	}
}

function deviceStep(step: Step, gen: Gen): string[] {
	gen.uses.device = true;
	switch (step.kind) {
		case "alert":
			return [
				`await device.alert(${typeof step.action === "string" ? lit(step.action) : `{ button: ${lit(step.action.button)} }`});`,
			];
		case "home":
			return ["await device.home();"];
		case "back":
			return ["await device.back();"];
		case "reload":
			return [
				'if (!device.devtools) throw new Error("reload needs a Metro devtools session");',
				"await device.devtools.reloadJs();",
			];
		case "rotate":
			return [`await device.orientation(${lit(step.orientation)});`];
		case "appearance":
			return [`await device.appearance(${lit(step.mode)});`];
		case "snapshot":
			return [`await ${call("device.snapshot", step.interactiveOnly === true ? "{ interactiveOnly: true }" : "")};`];
		case "screenshot":
			return [`await device.screenshot(${lit(step.name ?? `step-${step.i}`)});`];
		default:
			throw new Error(`unhandled step kind ${step.kind}`);
	}
}

function statements(step: Step, gen: Gen): string[] {
	if (step.kind === "open") return open(step, gen);
	return interaction(step, gen) ?? gestures(step, gen) ?? checks(step, gen) ?? deviceStep(step, gen);
}

function withSettle(step: Step, lines: string[], gen: Gen): string[] {
	if (!step.settle) return lines;
	gen.uses.device = true;
	const opts = options([
		["quietMs", step.settle.quietMs],
		["timeout", step.settle.timeoutMs],
	]);
	return [...lines, `await ${call("device.settle", opts)};`];
}

// ---- the file ---------------------------------------------------------------------------------------------------

function idsBlock(registry: IdRegistry): string[] {
	const entries = Object.entries(registry.toObject()).map(
		([key, id]) => `\t${IDENTIFIER.test(key) ? key : lit(key)}: ${lit(id)},`
	);
	return ["const ids = {", ...entries, "} as const;", ""];
}

export function exportFlow(flow: Flow, options: ExportOptions = {}): ExportResult {
	const gen: Gen = {
		registry: new IdRegistry(options.ids ?? {}),
		uses: { app: false, device: false, screen: false, expect: false, ids: false },
		secrets: new Map(),
	};

	const body: string[] = [];
	for (const step of flow.steps) {
		const lines = withSettle(step, statements(step, gen), gen);
		if (step.note) body.push(`// ${step.note.replaceAll(/\s+/g, " ")}`);
		body.push(...lines);
	}

	const secretLines = [...gen.secrets].flatMap(([name, variable]) => [
		`const ${variable} = process.env.${SECRET_PREFIX}${name};`,
		`if (${variable} === undefined) throw new Error(${lit(`set ${SECRET_PREFIX}${name} to run this flow`)});`,
	]);
	const fixtures = (["app", "device", "screen"] as const).filter((name) => gen.uses[name]);
	const importFrom = options.importFrom ?? DEFAULT_IMPORT;

	const out: string[] = [
		`// Generated by \`warden ui export\` from the recorded flow ${lit(flow.name)}. Review any FIXME before committing.`,
	];
	if (options.idsImport && gen.registry.newKeys.length > 0) {
		out.push(`// New test ids to add to ${options.idsImport}: ${gen.registry.newKeys.join(", ")}`);
	}
	out.push(`import { ${[...(gen.uses.expect ? ["expect"] : []), "test"].join(", ")} } from ${lit(importFrom)};`);
	if (gen.uses.ids && options.idsImport) out.push(`import { ids } from ${lit(options.idsImport)};`);
	out.push("");
	if (gen.uses.ids && !options.idsImport) out.push(...idsBlock(gen.registry));
	const params = fixtures.length === 0 ? "" : `{ ${fixtures.join(", ")} }`;
	const inner = [...secretLines, ...body];
	out.push(`test(${lit(flow.name)}, async (${params}) => {`);
	out.push(...(inner.length === 0 ? ["\t// no steps were recorded"] : inner.map((line) => `\t${line}`)));
	out.push("});", "");

	return { spec: out.join("\n"), ids: gen.registry.toObject() };
}
