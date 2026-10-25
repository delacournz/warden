import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { SharedSpecOptions } from "@delacour/warden-e2e/authoring/codegen";
import type { RecordedStep, Recording } from "@delacour/warden-e2e/authoring/recording.schema";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { helperOpensApp, parseHelperRef } from "./authoring-target";

/**
 * Shared spec options and the launch a recording needs. A suite's hand-written specs usually share one `test.use`
 * object (`SPEC_OPTIONS`: `launch: "none"`, `systemAlerts: "dismiss"`, …) from a helpers module; a generated spec
 * should pass the same one instead of drifting from its neighbours.
 */

/** The keys of the runner's `UseOptions`: an object literal that sets only these is a `test.use` options object. */
export const USE_OPTION_KEYS: ReadonlySet<string> = new Set([
	"timeout",
	"actionTimeout",
	"assertionTimeout",
	"launch",
	"systemAlerts",
]);

export type SharedOptionsLookup =
	| { kind: "found"; options: SharedSpecOptions }
	| { kind: "none" }
	| { kind: "ambiguous"; names: string[] };

type Candidate = { file: string; name: string; launch?: "none" | "fresh" };

const SOURCE_FILE = /\.tsx?$/;
const SPEC_FILE = /\.e2e\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$/;
const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git"]);

function sourceFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.sort((a, b) => (a.name < b.name ? -1 : 1))
		.flatMap((entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(path);
			return SOURCE_FILE.test(entry.name) ? [path] : [];
		});
}

const EXPORTED_OBJECT = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::\s*UseOptions\s*)?=\s*\{([^{}]*)\}/gm;
const OBJECT_KEY = /(?:^|,)\s*(?:([A-Za-z_$][\w$]*)|"([^"]+)")\s*:/g;

/** The `export const NAME = { … }` objects in `source` whose keys all belong to `UseOptions` (and are not empty). */
export function useOptionObjects(source: string): { name: string; launch?: "none" | "fresh" }[] {
	return [...source.matchAll(EXPORTED_OBJECT)].flatMap((match) => {
		const [, name = "", body = ""] = match;
		const keys = [...body.matchAll(OBJECT_KEY)].map((key) => key[1] ?? key[2] ?? "");
		if (keys.length === 0 || !keys.every((key) => USE_OPTION_KEYS.has(key))) return [];
		const launch = /\blaunch\s*:\s*["'](none|fresh)["']/.exec(body)?.[1];
		return [{ name, ...(launch === "none" || launch === "fresh" ? { launch } : {}) }];
	});
}

/** Whether the spec at `specFile` imports `name` from the module `file` and passes it to `test.use`. */
function specPasses(specFile: string, source: string, file: string, name: string): boolean {
	const target = file.replace(/\.tsx?$/, "");
	const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']*)["']/g)];
	const imported = imports.some((match) => {
		const specifiers = (match[1] ?? "").split(",").map((part) => part.trim().replace(/^type\s+/, ""));
		return (
			specifiers.includes(name) &&
			resolve(dirname(specFile), (match[2] ?? "").replace(/\.[cm]?[jt]sx?$/, "")) === target
		);
	});
	return (
		imported &&
		new RegExp(`\\btest\\.use\\(\\s*(?:\\{\\s*\\.\\.\\.\\s*)?${name.replaceAll("$", "\\$")}\\b`).test(source)
	);
}

/**
 * The shared `test.use` options of the specs below `specsDir`, by an explicit rule:
 *
 * 1. candidates: `export const NAME = { … }` in a `.ts`/`.tsx` file there that is neither a spec (`*.e2e.ts`) nor a
 *    test (`*.test.ts`), where the object sets at least one key and only keys of the runner's `UseOptions`;
 * 2. kept: those that at least one existing spec imports (relative import) and passes to `test.use(NAME)` or
 *    `test.use({ ...NAME, … })`;
 * 3. exactly one kept = found; several = ambiguous (nothing is guessed; `record start --options` picks); none = none.
 */
export function findSharedSpecOptions(specsDir: string): SharedOptionsLookup {
	const files = sourceFiles(specsDir);
	const specs = files
		.filter((file) => SPEC_FILE.test(file))
		.map((file) => ({ file, source: readFileSync(file, "utf8") }));
	const candidates: Candidate[] = files
		.filter((file) => !SPEC_FILE.test(file) && !TEST_FILE.test(file))
		.flatMap((file) => useOptionObjects(readFileSync(file, "utf8")).map((found) => ({ file, ...found })));
	const kept = candidates.filter((candidate) =>
		specs.some((spec) => specPasses(spec.file, spec.source, candidate.file, candidate.name))
	);
	const [only, ...rest] = kept;
	if (only === undefined) return { kind: "none" };
	if (rest.length > 0) return { kind: "ambiguous", names: kept.map((candidate) => candidate.name) };
	return {
		kind: "found",
		options: { module: only.file, name: only.name, ...(only.launch !== undefined ? { launch: only.launch } : {}) },
	};
}

const EXTENSIONS = [".ts", ".tsx"] as const;

/** `--options <module>#<name>`: the module (relative to `cwd`) must export `name` as a `UseOptions`-shaped object. */
export function resolveOptionsRef(raw: string, cwd: string): Result<SharedSpecOptions> {
	const ref = parseHelperRef(raw, "--options");
	if (!ref.success) return ref;
	const base = resolve(cwd, ref.data.module).replace(/\.[cm]?[jt]sx?$/, "");
	const file = [resolve(cwd, ref.data.module), ...EXTENSIONS.map((extension) => `${base}${extension}`)].find(
		(candidate) => SOURCE_FILE.test(candidate) && existsSync(candidate)
	);
	if (file === undefined) return err(`${resolve(cwd, ref.data.module)} does not exist`);
	const found = useOptionObjects(readFileSync(file, "utf8")).find((object) => object.name === ref.data.fn);
	if (found === undefined) {
		return err(
			`${relative(cwd, file)} does not export ${ref.data.fn} as an object of test.use options (${[...USE_OPTION_KEYS].join(", ")})`
		);
	}
	return ok({ module: file, name: found.name, ...(found.launch !== undefined ? { launch: found.launch } : {}) });
}

/** The same object, re-read from disk (its launch may have changed since `record start`). */
export function reloadOptions(options: SharedSpecOptions): SharedSpecOptions {
	if (!existsSync(options.module)) return options;
	const found = useOptionObjects(readFileSync(options.module, "utf8")).find((object) => object.name === options.name);
	return found === undefined
		? options
		: { ...options, ...(found.launch !== undefined ? { launch: found.launch } : {}) };
}

/** The first step that does something: notes do not count. */
function firstAction(recording: Recording): RecordedStep | undefined {
	return recording.steps.find((step) => step.kind !== "note");
}

/**
 * `"none"` when the recording launches the app itself, so the runner must not launch it first: its first step is an
 * `open` of the app (not a bare deep link), or a `use` of a helper whose body opens it (see `helperOpensApp`).
 * `"fresh"` otherwise: the runner's own launch is what puts the app on screen.
 */
export function neededLaunch(
	recording: Recording,
	readHelper: (module: string) => string | undefined
): "none" | "fresh" {
	const first = firstAction(recording);
	if (first?.kind === "open") return first.app === undefined && first.url !== undefined ? "fresh" : "none";
	if (first?.kind === "use") {
		const source = readHelper(first.module);
		return source !== undefined && helperOpensApp(source, first.fn) ? "none" : "fresh";
	}
	return "fresh";
}
