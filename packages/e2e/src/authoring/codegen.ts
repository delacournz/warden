import { dirname, isAbsolute, relative } from "node:path";
import { roleResolver } from "@delacour/warden-screen/roles";
import { type ParsedSelector, type SelectorValue, selectorEngine } from "@delacour/warden-screen/selector";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { LaunchMode } from "../runner/fixtures.types";
import type {
	GestureStep,
	RecordedStep,
	Recording,
	ScreenStep,
	SelectorTarget,
	StepOf,
	Target,
	Text,
} from "./recording.schema";
import { SECRET_PREFIX } from "./secrets";

/**
 * Codegen: turn a recording into a `*.e2e.ts` spec for `@delacour/warden-e2e`, or into a reusable helper function in a
 * helpers module. Pure text generation: the same recording always yields the same file, so the output is reviewable and
 * golden-testable. Selectors become `getBy*` locators (test ids go through an `ids` map), `wait`/`is` become `expect`
 * matchers, notes become comments, and anything the spec API cannot express (coordinates other than a tap, untargeted
 * typing) is a loud `FIXME` that throws instead of passing silently.
 */

export type CodegenOptions = {
	/** known test ids, `{ key: testId }`; keys are reused, new test ids get a generated camelCase key */
	ids?: Record<string, string>;
	/** import the ids map from this module instead of declaring it inline */
	idsImport?: string;
	/** the caller merges new ids into `idsImport` itself, so no "add these ids" comment is emitted */
	idsMerged?: boolean;
	/** where `test`/`expect` come from. Default `@delacour/warden-e2e`. */
	importFrom?: string;
	/** the generated test's title; falls back to the recording's `title`, then its `name` */
	title?: string;
	/** where the output will be written (absolute); `use` steps import their helper relative to it */
	file?: string;
	/** the suite's shared `test.use` options (e.g. `SPEC_OPTIONS`): imported and passed as `test.use(NAME)` */
	specOptions?: SharedSpecOptions;
	/**
	 * the launch this spec needs. `"none"` when the recording opens the app itself (its first step is an `open`, or a
	 * `use` of a helper that opens it) so the runner does not launch it first; `"fresh"` when the runner has to. A
	 * `test.use` line is written only when it differs from what `specOptions` (or the runner's default, `"fresh"`) gives.
	 */
	launch?: LaunchMode;
};

/** A `test.use` options object exported from a module next to the specs. */
export type SharedSpecOptions = {
	/** the module: an absolute path (imported relative to the spec) or a specifier kept as written */
	module: string;
	/** the exported const */
	name: string;
	/** the launch the object sets; absent = the runner's default (`"fresh"`) */
	launch?: LaunchMode;
};

export type SpecResult = {
	source: string;
	/** every id the output uses plus the ones passed in, `{ key: testId }` */
	ids: Record<string, string>;
};

export type HelperOptions = Omit<CodegenOptions, "title"> & {
	/** the exported function name; a valid identifier */
	name: string;
	/** what has to be true before the helper runs; becomes `/** Prerequisite: … *\/` above it */
	prerequisite?: string;
	/** the helpers module as it is on disk; omit to create one */
	existing?: string;
	/** replace an existing export of the same name instead of refusing */
	force?: boolean;
};

export type HelperResult = {
	/** the whole helpers module */
	source: string;
	ids: Record<string, string>;
	/** an existing export of `name` was replaced */
	replaced: boolean;
};

export type CodegenErrorCode = "bad_name" | "helper_exists" | "helper_unreplaceable" | "ids_unreadable";
export type CodegenError = { code: CodegenErrorCode; message: string };

const DEFAULT_IMPORT = "@delacour/warden-e2e";
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

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
		const base = specGenerator.idKey(testId);
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

type Uses = { app: boolean; device: boolean; screen: boolean; expect: boolean; ids: boolean; fixtures: boolean };

type Gen = {
	registry: IdRegistry;
	uses: Uses;
	/** secret name → variable holding its value */
	secrets: Map<string, string>;
	/** where the output is written, for the relative import of a `use` step's module */
	file: string | undefined;
	/** import specifier → helper functions called from it, in first-use order */
	helpers: Map<string, string[]>;
};

// ---- selectors → locators ---------------------------------------------------------------------------------------

type Terms = Omit<ParsedSelector, "nth">;
type TermKey = "id" | "label" | "text" | "role" | "value";
const TERM_KEYS: readonly TermKey[] = ["id", "label", "text", "role", "value"];

// ---- values -----------------------------------------------------------------------------------------------------

// ---- steps → statements -----------------------------------------------------------------------------------------

const IS_MATCHERS = {
	visible: "toBeVisible()",
	hidden: "toBeHidden()",
	enabled: "toBeEnabled()",
	disabled: "toBeDisabled()",
	checked: "toBeChecked()",
	unchecked: "toBeChecked({ checked: false })",
} as const;

const MODULE_EXTENSION = /\.[cm]?[jt]sx?$/;

// ---- ids modules ------------------------------------------------------------------------------------------------

const IDS_DECLARATION = /^(export )?const ids = \{\n([\s\S]*?)\} as const;/m;
const IDS_ENTRY = /^\s*(?:([A-Za-z_$][\w$]*)|("(?:[^"\\]|\\.)*"))\s*:\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/;

// ---- the file ---------------------------------------------------------------------------------------------------

type Fixture = "app" | "device" | "screen";
const FIXTURES: readonly Fixture[] = ["app", "device", "screen"];

type Compiled = {
	gen: Gen;
	/** the callback takes the whole fixtures object (a `use` step passes it on) and destructures what the rest needs */
	wholeFixtures: boolean;
	/** statements and comments, unindented, in order */
	body: string[];
	/** the `WARDEN_UI_SECRET_<NAME>` reads that open the body */
	secretLines: string[];
	fixtures: Fixture[];
};

// ---- helpers ----------------------------------------------------------------------------------------------------

const HELPER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IMPORT_STATEMENT = /^import[^;]*;[ \t]*\n/gm;

type ExportSite = { kind: "function"; start: number; end: number } | { kind: "other" } | { kind: "none" };

export class SpecGenerator {
	private codegenError(code: CodegenErrorCode, message: string): { success: false; error: CodegenError } {
		return { success: false, error: { code, message } };
	}

	private lit(value: string): string {
		return JSON.stringify(value);
	}

	/** `sign-in-submit` → `signInSubmit`; always a valid identifier. */
	idKey(testId: string): string {
		const words = testId.split(/[^A-Za-z0-9]+/).filter((word) => word !== "");
		const [first = "id", ...rest] = words;
		const joined = [
			first.charAt(0).toLowerCase() + first.slice(1),
			...rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1)),
		].join("");
		return /^[0-9]/.test(joined) ? `id${joined.charAt(0).toUpperCase()}${joined.slice(1)}` : joined;
	}

	private onlyText(value: SelectorValue | undefined): string | undefined {
		return value?.kind === "text" ? value.value : undefined;
	}

	private idLocator(testId: string, gen: Gen): string {
		gen.uses.ids = true;
		const key = gen.registry.keyFor(testId);
		return `screen.getByTestId(${IDENTIFIER.test(key) ? `ids.${key}` : `ids[${this.lit(key)}]`})`;
	}

	private roleLocator(role: string | undefined, name: string | undefined): string | undefined {
		if (role === undefined || !roleResolver.isQueryRole(role)) return undefined;
		return `screen.${this.call("getByRole", this.lit(role), name === undefined ? "" : this.lit(name))}`;
	}

	/** The `getBy*` call for a selector's terms, or undefined when only `screen.locator(...)` can say it. */
	private baseLocator(terms: Terms, gen: Gen): string | undefined {
		if (terms.editable !== undefined) return undefined;
		const texts: Partial<Record<TermKey, string>> = {};
		for (const key of TERM_KEYS) {
			const value = this.onlyText(terms[key]);
			if (terms[key] !== undefined && value === undefined) return undefined;
			if (value !== undefined) texts[key] = value;
		}
		const { id, label, text, role, value } = texts;
		const shape = TERM_KEYS.filter((key) => texts[key] !== undefined).join("+");
		switch (shape) {
			case "id":
				return id === undefined ? undefined : this.idLocator(id, gen);
			case "label":
				return `screen.getByLabel(${this.lit(label ?? "")})`;
			case "text":
				return `screen.getByText(${this.lit(text ?? "")})`;
			case "value":
				return `screen.getByValue(${this.lit(value ?? "")})`;
			case "role":
				return this.roleLocator(role, undefined);
			case "label+role":
				return this.roleLocator(role, label);
			case "text+role":
				return this.roleLocator(role, text);
			default:
				return undefined;
		}
	}

	private locatorOf(target: SelectorTarget, gen: Gen): string {
		gen.uses.screen = true;
		const parsed = selectorEngine.parseSelector(target.selector);
		if (!parsed.success) return `screen.locator(${this.lit(target.selector)})`;
		const { nth, ...terms } = parsed.data;
		const base = this.baseLocator(terms, gen);
		if (base === undefined) return `screen.locator(${this.lit(target.selector)})`;
		return nth === undefined ? base : `${base}.nth(${nth})`;
	}

	private camel(name: string): string {
		return this.idKey(name.toLowerCase());
	}

	/** Literal text, or the variable that holds a `WARDEN_UI_SECRET_<NAME>` value (declared at the top of the test). */
	private textOf(value: Text, gen: Gen): string {
		if (typeof value === "string") return this.lit(value);
		const existing = gen.secrets.get(value.secret);
		if (existing !== undefined) return existing;
		const variable = `${this.camel(value.secret)}Secret`;
		gen.secrets.set(value.secret, variable);
		return variable;
	}

	private options(pairs: [string, string | number | boolean | undefined][]): string {
		const present = pairs.filter((pair): pair is [string, string | number | boolean] => pair[1] !== undefined);
		return present.length === 0
			? ""
			: `{ ${present.map(([key, value]) => `${key}: ${typeof value === "string" ? this.lit(value) : value}`).join(", ")} }`;
	}

	/** `name(a, b)` without trailing empty arguments. */
	private call(name: string, ...args: string[]): string {
		return `${name}(${args.filter((arg) => arg !== "").join(", ")})`;
	}

	private point(x: number, y: number): string {
		return `{ x: ${x}, y: ${y} }`;
	}

	/** A step the spec API cannot express: say so, and fail the test rather than skip the step. */
	private unsupported(what: string, why: string): string[] {
		return [
			`// FIXME: ${why}; the spec API has no ${what}`,
			`throw new Error(${this.lit(`FIXME: ${what} (${why})`)});`,
		];
	}

	/** `emit` with the locator of a selector target; a coordinate or missing target is an `unsupported` step. */
	private located(target: Target | undefined, gen: Gen, what: string, emit: (locator: string) => string[]): string[] {
		if (target?.kind === "selector") return emit(this.locatorOf(target, gen));
		return this.unsupported(what, target ? "recorded by coordinates" : "recorded without a target");
	}

	private open(step: StepOf<"open">, gen: Gen): string[] {
		if (step.app === undefined && step.url !== undefined) {
			gen.uses.device = true;
			return [`await device.openLink(${this.lit(step.url)});`];
		}
		gen.uses.app = true;
		const args = step.args === undefined ? undefined : `[${step.args.map((value) => this.lit(value)).join(", ")}]`;
		const pairs = [
			step.url === undefined ? "" : `url: ${this.lit(step.url)}`,
			args === undefined ? "" : `args: ${args}`,
			'wait: "quiet"',
		].filter(Boolean);
		return [`await ${this.call("app.open", pairs.length === 0 ? "" : `{ ${pairs.join(", ")} }`)};`];
	}

	private interaction(step: RecordedStep, gen: Gen): string[] | undefined {
		switch (step.kind) {
			case "press": {
				if (step.target.kind === "selector") return [`await ${this.locatorOf(step.target, gen)}.tap();`];
				gen.uses.screen = true;
				return [
					`// FIXME: recorded by coordinates (${step.target.warning})`,
					`await screen.tapAt(${this.point(step.target.x, step.target.y)});`,
				];
			}
			case "fill":
				return this.located(step.target, gen, "fill without an element", (l) => [
					`await ${l}.${this.call("fill", this.textOf(step.text, gen), step.via === "paste" ? `{ via: ${this.lit(step.via)} }` : "")};`,
				]);
			case "type":
				return this.located(step.target, gen, "typing without a target field", (l) => [
					`await ${l}.type(${this.textOf(step.text, gen)});`,
				]);
			case "key": {
				const modifiers = step.modifiers?.length
					? `{ modifiers: [${step.modifiers.map((value) => this.lit(value)).join(", ")}] }`
					: "";
				return this.located(step.target, gen, "key press without a target field", (l) => [
					`await ${l}.${this.call("press", this.lit(step.key), modifiers)};`,
				]);
			}
			default:
				return undefined;
		}
	}

	/** A swipe: by `path` through `screen.gesture.swipe({ from, to })`, else by direction on a locator or the screen. */
	private swipeGesture(step: Extract<GestureStep, { type: "swipe" }>, gen: Gen): string[] {
		if (step.by === "path") {
			gen.uses.screen = true;
			const { from, to, durationMs } = step;
			const duration = durationMs === undefined ? "" : `, durationMs: ${durationMs}`;
			return [
				`await screen.gesture.swipe({ from: ${this.point(from.x, from.y)}, to: ${this.point(to.x, to.y)}${duration} });`,
			];
		}
		const { direction, momentum, target } = step;
		const opts = this.options([
			["direction", direction],
			["momentum", momentum],
		]);
		if (target?.kind === "selector") return [`await ${this.locatorOf(target, gen)}.swipe(${opts});`];
		gen.uses.screen = true;
		return [
			...(target ? [`// FIXME: swipe target was recorded by coordinates (${target.warning})`] : []),
			`await screen.gesture.swipe(${opts});`,
		];
	}

	/** A pinch or rotate: a locator call when the target is a selector, else `screen.gesture.*` with a FIXME for a point. */
	private pinchRotateGesture(step: Extract<GestureStep, { type: "pinch" | "rotate" }>, gen: Gen): string[] {
		const amount = step.type === "pinch" ? step.scale : step.degrees;
		const opts = this.options([
			["durationMs", step.durationMs],
			["radius", step.radius],
		]);
		const { target } = step;
		if (target?.kind === "selector") {
			return [`await ${this.locatorOf(target, gen)}.${this.call(step.type, String(amount), opts)};`];
		}
		gen.uses.screen = true;
		const key = step.type === "pinch" ? "scale" : "degrees";
		const fields = [
			`${key}: ${amount}`,
			...(target ? [`center: ${this.point(target.x, target.y)}`] : []),
			...(step.durationMs === undefined ? [] : [`durationMs: ${step.durationMs}`]),
			...(step.radius === undefined ? [] : [`radius: ${step.radius}`]),
		];
		const spec = `{ ${fields.join(", ")} }`;
		return [
			...(target ? [`// FIXME: ${step.type} target was recorded by coordinates (${target.warning})`] : []),
			`await screen.gesture.${step.type}(${spec});`,
		];
	}

	/** A multi-finger path gesture through `screen.gesture.path`. */
	private pathGesture(step: Extract<GestureStep, { type: "path" }>, gen: Gen): string[] {
		gen.uses.screen = true;
		const paths = step.paths.map((path) => `[${path.map((p) => this.point(p.x, p.y)).join(", ")}]`).join(", ");
		const spec = `{ ${[`paths: [${paths}]`, ...(step.durationMs === undefined ? [] : [`durationMs: ${step.durationMs}`])].join(", ")} }`;
		return [`await screen.gesture.path(${spec});`];
	}

	/** `screen.gesture.swipe` takes `{ from, to }` or `{ direction }`, like `screen.swipe`; pinch/rotate on a locator or the screen. */
	private gesture(step: GestureStep, gen: Gen): string[] {
		switch (step.type) {
			case "longpress":
				return this.located(step.target, gen, "long press at a point", (l) => [
					`await ${l}.${this.call("longPress", this.options([["durationMs", step.durationMs]]))};`,
				]);
			case "swipe":
				return this.swipeGesture(step, gen);
			case "pinch":
			case "rotate":
				return this.pinchRotateGesture(step, gen);
			case "path":
				return this.pathGesture(step, gen);
		}
	}

	private gestures(step: RecordedStep, gen: Gen): string[] | undefined {
		switch (step.kind) {
			case "gesture":
				return this.gesture(step, gen);
			case "scroll": {
				gen.uses.screen = true;
				const direction = step.direction ?? "down";
				if (step.until?.kind === "selector") {
					const opts = this.options([
						["direction", direction],
						["maxSwipes", step.maxSwipes],
						["timeout", step.timeoutMs],
					]);
					return [`await screen.${this.call("scrollUntilVisible", this.locatorOf(step.until, gen), opts)};`];
				}
				return [
					...(step.until ? [`// FIXME: scroll target was recorded by coordinates (${step.until.warning})`] : []),
					`await screen.swipe(${this.options([["direction", direction]])});`,
				];
			}
			default:
				return undefined;
		}
	}

	private checks(step: RecordedStep, gen: Gen): string[] | undefined {
		switch (step.kind) {
			case "wait": {
				const state = step.state ?? "visible";
				return this.located(step.target, gen, "wait on a point", (l) => {
					if (state === "attached" || state === "detached") {
						return [
							`await ${l}.${this.call(
								"waitFor",
								this.options([
									["state", state],
									["timeout", step.timeoutMs],
								])
							)};`,
						];
					}
					gen.uses.expect = true;
					const matcher = state === "visible" ? "toBeVisible" : "toBeHidden";
					return [`await expect(${l}).${this.call(matcher, this.options([["timeout", step.timeoutMs]]))};`];
				});
			}
			case "is":
				return this.located(step.target, gen, "state check on a point", (l) => {
					gen.uses.expect = true;
					return [`await expect(${l})${step.not === true ? ".not" : ""}.${IS_MATCHERS[step.state]};`];
				});
			case "get":
				return this.located(step.target, gen, "read from a point", (l) => {
					gen.uses.expect = true;
					const matcher = step.property === "text" ? "toHaveText" : "toHaveValue";
					return [`await expect(${l}).${matcher}(${this.textOf(step.expected, gen)});`];
				});
			default:
				return undefined;
		}
	}

	private screenStep(step: ScreenStep): string[] {
		switch (step.type) {
			case "rotate":
				return [`await device.orientation(${this.lit(step.orientation)});`];
			case "appearance":
				return [`await device.appearance(${this.lit(step.mode)});`];
			case "screenshot":
				return [`await device.screenshot(${this.lit(step.name ?? `step-${step.i}`)});`];
		}
	}

	private deviceStep(step: RecordedStep, gen: Gen): string[] {
		gen.uses.device = true;
		switch (step.kind) {
			case "alert":
				return [
					`await device.alert(${typeof step.action === "string" ? this.lit(step.action) : `{ button: ${this.lit(step.action.button)} }`});`,
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
			case "screen":
				return this.screenStep(step);
			case "snapshot":
				return [
					`await ${this.call("device.snapshot", step.interactiveOnly === true ? "{ interactiveOnly: true }" : "")};`,
				];
			default:
				throw new Error(`unhandled step kind ${step.kind}`);
		}
	}

	/** The import specifier for a helper module: relative to the output file when both are absolute, never with the extension. */
	moduleSpecifier(module: string, file: string | undefined): string {
		if (!isAbsolute(module)) return module;
		if (file === undefined || !isAbsolute(file)) return module.replace(MODULE_EXTENSION, "");
		const rel = relative(dirname(file), module).replace(MODULE_EXTENSION, "");
		return rel.startsWith(".") ? rel : `./${rel}`;
	}

	/** `await fn(fixtures)`: the helper takes the whole `TestFixtures` object, which the test callback keeps as `fixtures`. */
	private useHelper(step: StepOf<"use">, gen: Gen): string[] {
		gen.uses.fixtures = true;
		const specifier = this.moduleSpecifier(step.module, gen.file);
		const names = gen.helpers.get(specifier) ?? [];
		if (!names.includes(step.fn)) gen.helpers.set(specifier, [...names, step.fn]);
		return [`await ${step.fn}(fixtures);`];
	}

	private statements(step: RecordedStep, gen: Gen): string[] {
		if (step.kind === "note") return [];
		if (step.kind === "use") return this.useHelper(step, gen);
		if (step.kind === "open") return this.open(step, gen);
		return (
			this.interaction(step, gen) ?? this.gestures(step, gen) ?? this.checks(step, gen) ?? this.deviceStep(step, gen)
		);
	}

	private withSettle(step: RecordedStep, lines: string[], gen: Gen): string[] {
		if (!step.settle) return lines;
		gen.uses.device = true;
		const opts = this.options([
			["quietMs", step.settle.quietMs],
			["timeout", step.settle.timeoutMs],
		]);
		return [...lines, `await ${this.call("device.settle", opts)};`];
	}

	private idsEntries(ids: Record<string, string>): string[] {
		return Object.entries(ids).map(([key, id]) => `\t${IDENTIFIER.test(key) ? key : this.lit(key)}: ${this.lit(id)},`);
	}

	/** The `{ key: testId }` pairs of the `const ids = { … } as const;` in a module's source; empty when there is none. */
	parseIdsModule(source: string): Record<string, string> {
		const body = IDS_DECLARATION.exec(source)?.[2];
		if (body === undefined) return {};
		const ids: Record<string, string> = {};
		for (const line of body.split("\n")) {
			const match = IDS_ENTRY.exec(line);
			if (!match) continue;
			const key = match[1] ?? (match[2] === undefined ? undefined : (JSON.parse(match[2]) as string));
			if (key !== undefined && match[3] !== undefined) ids[key] = JSON.parse(match[3]) as string;
		}
		return ids;
	}

	/**
	 * Add `ids` to the ids module: create `export const ids = { … } as const;`, or insert the keys it does not have yet
	 * before the closing line of the existing declaration (everything else in the file is kept).
	 */
	mergeIdsModule(existing: string | undefined, ids: Record<string, string>): Result<string, CodegenError> {
		if (existing === undefined)
			return resultFactory.ok(["export const ids = {", ...this.idsEntries(ids), "} as const;", ""].join("\n"));
		const match = IDS_DECLARATION.exec(existing);
		if (!match)
			return this.codegenError("ids_unreadable", "no `const ids = { … } as const;` declaration to add the test ids to");
		const known = this.parseIdsModule(existing);
		const fresh = Object.fromEntries(Object.entries(ids).filter(([key]) => !(key in known)));
		if (Object.keys(fresh).length === 0) return resultFactory.ok(existing);
		const close = match.index + match[0].length - "} as const;".length;
		return resultFactory.ok(
			`${existing.slice(0, close)}${this.idsEntries(fresh).join("\n")}\n${existing.slice(close)}`
		);
	}

	private oneLine(text: string): string {
		return text.replaceAll(/\s+/g, " ").trim();
	}

	/** `// text` above the step it explains; a note between steps gets a blank line before it. */
	private compile(recording: Recording, known: Record<string, string>, file: string | undefined): Compiled {
		const gen: Gen = {
			registry: new IdRegistry(known),
			uses: { app: false, device: false, screen: false, expect: false, ids: false, fixtures: false },
			secrets: new Map(),
			file,
			helpers: new Map(),
		};

		const body: string[] = [];
		for (const step of recording.steps) {
			if (step.kind === "note") {
				if (body.length > 0) body.push("");
				body.push(`// ${this.oneLine(step.text)}`);
				continue;
			}
			const lines = this.withSettle(step, this.statements(step, gen), gen);
			if (step.note) body.push(`// ${this.oneLine(step.note)}`);
			body.push(...lines);
		}

		const secretLines = [...gen.secrets].flatMap(([name, variable]) => [
			`const ${variable} = process.env.${SECRET_PREFIX}${name};`,
			`if (${variable} === undefined) throw new Error(${this.lit(`set ${SECRET_PREFIX}${name} to run this spec`)});`,
		]);
		const fixtures = FIXTURES.filter((name) => gen.uses[name]);
		const destructure =
			gen.uses.fixtures && fixtures.length > 0 ? [`const { ${fixtures.join(", ")} } = fixtures;`] : [];
		return { gen, wholeFixtures: gen.uses.fixtures, body, secretLines: [...destructure, ...secretLines], fixtures };
	}

	private indented(lines: readonly string[]): string[] {
		return lines.map((line) => (line === "" ? "" : `\t${line}`));
	}

	private innerLines(compiled: Compiled): string[] {
		const inner = [...compiled.secretLines, ...compiled.body];
		return inner.length === 0 ? ["\t// no steps were recorded"] : this.indented(inner);
	}

	private idsBlock(registry: IdRegistry, exported: boolean): string[] {
		return [`${exported ? "export " : ""}const ids = {`, ...this.idsEntries(registry.toObject()), "} as const;", ""];
	}

	private bannerFor(recording: Recording): string {
		return `// Generated by \`warden ui record\` from the recording ${this.lit(recording.name)}. Review any FIXME before committing.`;
	}

	/**
	 * The file-scope `test.use(...)` the spec needs, or undefined for none. The runner has no per-test launch option, so
	 * the launch rides on `test.use` like the hand-written specs' shared options do.
	 */
	private useLine(options: CodegenOptions): string | undefined {
		const { specOptions: shared, launch } = options;
		const base: LaunchMode = shared?.launch ?? "fresh";
		const override = launch !== undefined && launch !== base ? launch : undefined;
		if (shared === undefined)
			return override === undefined ? undefined : `test.use({ launch: ${this.lit(override)} });`;
		return override === undefined
			? `test.use(${shared.name});`
			: `test.use({ ...${shared.name}, launch: ${this.lit(override)} });`;
	}

	private byName(a: string, b: string): number {
		const [x, y] = [a.toLowerCase(), b.toLowerCase()];
		return x < y ? -1 : x > y ? 1 : 0;
	}

	/** The non-framework imports a spec needs: the ids import, recorded helpers, and the shared spec options. */
	private specImports(gen: Gen, options: CodegenOptions, usesOptions: boolean): Map<string, string[]> {
		const imports = new Map<string, string[]>();
		if (gen.uses.ids && options.idsImport) imports.set(options.idsImport, ["ids"]);
		for (const [specifier, names] of gen.helpers) imports.set(specifier, [...(imports.get(specifier) ?? []), ...names]);
		if (usesOptions && options.specOptions !== undefined) {
			const specifier = this.moduleSpecifier(options.specOptions.module, options.file);
			imports.set(
				specifier,
				[...(imports.get(specifier) ?? []), options.specOptions.name].sort((a, b) => this.byName(a, b))
			);
		}
		return imports;
	}

	/** The `*.e2e.ts` source for a recording: one `test(...)` using the `app` / `device` / `screen` fixtures it needs. */
	generateSpec(recording: Recording, options: CodegenOptions = {}): SpecResult {
		const compiled = this.compile(recording, options.ids ?? {}, options.file);
		const { gen, fixtures } = compiled;
		const importFrom = options.importFrom ?? DEFAULT_IMPORT;

		const out: string[] = [this.bannerFor(recording)];
		if (options.idsImport && !options.idsMerged && gen.registry.newKeys.length > 0) {
			out.push(`// New test ids to add to ${options.idsImport}: ${gen.registry.newKeys.join(", ")}`);
		}
		out.push(`import { ${[...(gen.uses.expect ? ["expect"] : []), "test"].join(", ")} } from ${this.lit(importFrom)};`);
		const useStatement = this.useLine(options);
		const imports = this.specImports(gen, options, useStatement !== undefined);
		for (const [specifier, names] of [...imports].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			out.push(`import { ${names.join(", ")} } from ${this.lit(specifier)};`);
		out.push("");
		if (useStatement !== undefined) out.push(useStatement, "");
		if (gen.uses.ids && !options.idsImport) out.push(...this.idsBlock(gen.registry, false));
		const params = compiled.wholeFixtures ? "fixtures" : fixtures.length === 0 ? "" : `{ ${fixtures.join(", ")} }`;
		const title = options.title ?? recording.title ?? recording.name;
		out.push(`test(${this.lit(title)}, async (${params}) => {`, ...this.innerLines(compiled), "});", "");

		return { source: out.join("\n"), ids: gen.registry.toObject() };
	}

	/** The helper function: a doc comment, then `export async function name({ … }: TestFixtures): Promise<void>`. */
	private helperFunction(
		name: string,
		prerequisite: string | undefined,
		recording: Recording,
		compiled: Compiled
	): string {
		const doc =
			prerequisite === undefined
				? `/** Replays the recording ${this.lit(recording.name)}. */`
				: `/** Prerequisite: ${this.oneLine(prerequisite).replaceAll("*/", "* /")} */`;
		const params = compiled.wholeFixtures
			? "fixtures: TestFixtures"
			: compiled.fixtures.length === 0
				? ""
				: `{ ${compiled.fixtures.join(", ")} }: TestFixtures`;
		return [
			doc,
			`export async function ${name}(${params}): Promise<void> {`,
			...this.innerLines(compiled),
			"}",
			"",
		].join("\n");
	}

	private bareName(specifier: string): string {
		return specifier.trim().replace(/^type\s+/, "");
	}

	/** Make sure `names` are imported from `from`: added to its existing import, or a new statement after the last import. */
	private withImport(source: string, from: string, names: readonly string[]): string {
		const existing = new RegExp(`^import\\s*\\{([^}]*)\\}\\s*from\\s*${this.lit(from)};?[ \\t]*$`, "m").exec(source);
		if (existing) {
			const have = (existing[1] ?? "")
				.split(",")
				.map((name) => name.trim())
				.filter((name) => name !== "");
			const missing = names.filter((name) => !have.some((taken) => this.bareName(taken) === this.bareName(name)));
			if (missing.length === 0) return source;
			const statement = `import { ${[...have, ...missing].join(", ")} } from ${this.lit(from)};`;
			return source.slice(0, existing.index) + statement + source.slice(existing.index + existing[0].length);
		}
		const statement = `import { ${names.join(", ")} } from ${this.lit(from)};\n`;
		const lastImport = [...source.matchAll(IMPORT_STATEMENT)].at(-1);
		if (!lastImport) return `${statement}\n${source}`;
		const end = lastImport.index + lastImport[0].length;
		return source.slice(0, end) + statement + source.slice(end);
	}

	/** After the imports: the inline ids block (new) or the new keys inserted into the existing one. */
	private withInlineIds(source: string, registry: IdRegistry): Result<string, CodegenError> {
		if (IDS_DECLARATION.test(source)) return this.mergeIdsModule(source, registry.toObject());
		const lastImport = [...source.matchAll(IMPORT_STATEMENT)].at(-1);
		const at = lastImport ? lastImport.index + lastImport[0].length : 0;
		const block = `\n${this.idsBlock(registry, false).join("\n")}`;
		return resultFactory.ok(source.slice(0, at) + block + source.slice(at));
	}

	/** The helper's ids: imported from the ids module, or declared / extended inline. */
	private addIds(source: string, registry: IdRegistry, idsImport: string | undefined): Result<string, CodegenError> {
		return idsImport
			? resultFactory.ok(this.withImport(source, idsImport, ["ids"]))
			: this.withInlineIds(source, registry);
	}

	/** Where `export … function name` sits (with its doc comment), or whether `name` is exported some other way. */
	private findExport(source: string, name: string): ExportSite {
		const fn = new RegExp(`^export\\s+(?:async\\s+)?function\\s+${name}\\b`, "m").exec(source);
		if (!fn) {
			return new RegExp(`^export\\s+(?:const|let|var|class)\\s+${name}\\b`, "m").test(source)
				? { kind: "other" }
				: { kind: "none" };
		}
		const above = source.slice(0, fn.index);
		const doc = /\/\*\*(?:(?!\*\/)[\s\S])*\*\/\n$/.exec(above);
		const close = source.indexOf("\n}\n", fn.index);
		const end = close === -1 ? source.length : close + 3;
		return { kind: "function", start: doc ? doc.index : fn.index, end };
	}

	/** Where `options.name` is already exported in `existing`, refusing what `force` cannot or did not ask to replace. */
	private locateExport(existing: string | undefined, options: HelperOptions): Result<ExportSite, CodegenError> {
		const site = existing === undefined ? ({ kind: "none" } as const) : this.findExport(existing, options.name);
		if (site.kind === "other") {
			return this.codegenError("helper_unreplaceable", `${options.name} is exported but is not a function declaration`);
		}
		if (site.kind === "function" && options.force !== true) {
			return this.codegenError("helper_exists", `${options.name} is already exported`);
		}
		return resultFactory.ok(site);
	}

	/** Adds the framework imports and every recorded helper's import, skipping helpers from the module being written. */
	private withHelperImports(
		source: string,
		importFrom: string,
		names: readonly string[],
		compiled: Compiled,
		file: string | undefined
	): string {
		let next = names.length > 0 ? this.withImport(source, importFrom, names) : source;
		for (const [specifier, fns] of compiled.gen.helpers) {
			if (file !== undefined && specifier === this.moduleSpecifier(file, file)) continue;
			next = this.withImport(next, specifier, fns);
		}
		return next;
	}

	/**
	 * The helpers module with the recording added as an exported function: `existing` is the module as it is on disk
	 * (omit to create one). An existing export of the same name is refused unless `force`, which replaces it in place.
	 * Imports, the ids import or inline ids are added only when missing.
	 */
	generateHelper(recording: Recording, options: HelperOptions): Result<HelperResult, CodegenError> {
		if (!HELPER_NAME.test(options.name)) {
			return this.codegenError("bad_name", `${JSON.stringify(options.name)} is not a valid function name`);
		}
		const { existing, idsImport } = options;
		const importFrom = options.importFrom ?? DEFAULT_IMPORT;
		const found = this.locateExport(existing, options);
		if (!found.success) return found;
		const site = found.data;
		const inlineKnown = existing !== undefined && !idsImport ? this.parseIdsModule(existing) : {};
		const compiled = this.compile(recording, { ...inlineKnown, ...options.ids }, options.file);
		const fn = this.helperFunction(options.name, options.prerequisite, recording, compiled);
		const imports = [...(compiled.gen.uses.expect ? ["expect"] : []), "type TestFixtures"];

		let source = existing ?? "";
		if (site.kind === "function") source = source.slice(0, site.start) + fn + source.slice(site.end);
		const needsType = compiled.fixtures.length > 0 || compiled.wholeFixtures;
		const names = needsType ? imports : imports.filter((name) => name !== "type TestFixtures");
		source = this.withHelperImports(source, importFrom, names, compiled, options.file);
		const withIds = compiled.gen.uses.ids
			? this.addIds(source, compiled.gen.registry, idsImport)
			: resultFactory.ok(source);
		if (!withIds.success) return withIds;
		source = withIds.data;
		if (site.kind !== "function") source = `${source.trimEnd()}\n\n${fn}`;
		if (existing === undefined) source = `${this.bannerFor(recording)}\n${source.trimStart()}`;
		return resultFactory.ok({ source, ids: compiled.gen.registry.toObject(), replaced: site.kind === "function" });
	}
}

export const specGenerator = new SpecGenerator();
