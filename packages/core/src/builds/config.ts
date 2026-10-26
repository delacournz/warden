import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { z } from "zod";
import type { Platform } from "../types";
import {
	type BuildConfiguration,
	DEFAULT_EAS_PROFILE,
	defaultBuildCommand,
	LEGACY_CACHE_DIRS,
} from "./builds.defaults";
import type { projectConfigSchema, wardenConfigSchema } from "./config.schema";
import type { WardenConfigContext } from "./define-config";

/** The preferred config file, named in hints. */
export const CONFIG_FILE = "warden.config.ts";
/** Still read, so JSON configs keep working. */
export const JSON_CONFIG_FILE = "warden.config.json";
/** Every file name `findWardenConfig` looks for, in preference order; at most one may exist per dir. */
export const CONFIG_FILES = [
	CONFIG_FILE,
	"warden.config.mts",
	"warden.config.js",
	"warden.config.mjs",
	JSON_CONFIG_FILE,
];

/**
 * The zod schemas (`config.schema.ts`), loaded on the first parse: zod is ~95 modules that `run` / `dev` / `app` would
 * otherwise load at start (15-2). `require`, not `import()`: `loadProject` and `findWardenConfig` are synchronous.
 */
let schemas: typeof import("./config.schema") | undefined;
function configSchemas(): typeof import("./config.schema") {
	schemas ??= require("./config.schema") as typeof import("./config.schema");
	return schemas;
}

/** Parsed (defaults applied). The documented input types live in `define-config.ts`. */
export type ParsedProjectConfig = z.infer<typeof projectConfigSchema>;
export type ParsedWardenConfig = z.infer<typeof wardenConfigSchema>;

export type EasSettings = { profile: string; workflow?: string; trigger: boolean };

/** A project ready for the build cache: absolute root, defaults applied. */
export type Project = {
	name: string;
	root: string;
	bundleId: { ios?: string; android?: string };
	fingerprintCommand?: string;
	/** set = JS-aware key (`fingerprint.include: "native+js"`): globs of the JS sources the key covers */
	jsInputs?: string[];
	/** undefined = EAS not used (no `eas` config and no `eas.json`) */
	eas?: EasSettings;
	build: Record<Platform, string>;
	/** Debug unless `build.configuration` says Release */
	buildConfiguration: BuildConfiguration;
	/** false = `build.cache: false`: no shared compiler caches in local builds */
	compilerCache?: false;
	/** false = `build.prebuiltReactNative: false`: never opt iOS builds into the precompiled RN core */
	prebuiltReactNative?: false;
	/** the `variants.<name>` this project was resolved with; undefined = the project's own settings */
	variant?: string;
	cacheDirs: string[];
	/** where the project came from */
	origin: "config" | "app.json" | "app.config";
	/** which lookup found it: the repo's own config, the `~/.warden` overlay config, or autodetected from the app config */
	source: ConfigSource;
};

/** `repo` = a `warden.config.*` in the checkout; `overlay` = one in `<WARDEN_HOME>/projects/<key>/`; `auto` = none (app.json). */
export type ConfigSource = "repo" | "overlay" | "auto";

/** A parsed warden config and where it was found. */
export type FoundConfig = {
	/** the config's own dir: what a config function sees as `configDir`, and what suite `specsDir`s resolve against */
	dir: string;
	config: ParsedWardenConfig;
	source: Exclude<ConfigSource, "auto">;
	/** what `projects[].root` resolves against: `dir` for a repo config, the checkout root for an overlay one */
	rootDir: string;
};

/** Validate a config value; `file` names it in the error. */
export function parseWardenConfig(raw: unknown, file: string = CONFIG_FILE): Result<ParsedWardenConfig> {
	const parsed = configSchemas().wardenConfigSchema.safeParse(raw);
	if (parsed.success) return ok(parsed.data);
	const issues = parsed.error.issues
		.map((i) => {
			const where = i.path.join(".") || "(root)";
			// a message that already names its path (a removed key's migration hint) is not prefixed twice
			return i.message.startsWith(where) ? i.message : `${where}: ${i.message}`;
		})
		.join("; ");
	return err(`invalid ${file}: ${issues}`);
}

function expandHome(path: string, home: string | undefined): string {
	return path === "~" || path.startsWith("~/") ? join(home ?? "~", path.slice(1)) : path;
}

function readJson(path: string): Result<unknown> {
	try {
		return ok(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		return err(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function within(dir: string, target: string): boolean {
	const rel = relative(dir, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function fromConfig(entry: ParsedProjectConfig, configDir: string, env: Record<string, string | undefined>): Project {
	const root = resolve(configDir, entry.root);
	const configuration = entry.build?.configuration ?? "Debug";
	const project: Project = {
		name: entry.name,
		root,
		bundleId: entry.bundleId,
		build: {
			ios: entry.build?.ios ?? defaultBuildCommand("ios", configuration),
			android: entry.build?.android ?? defaultBuildCommand("android", configuration),
		},
		buildConfiguration: configuration,
		cacheDirs: (entry.cacheDirs ?? LEGACY_CACHE_DIRS[entry.name] ?? []).map((d) =>
			resolve(root, expandHome(d, env.HOME))
		),
		origin: "config",
		source: "repo",
	};
	if (entry.build?.cache === false) project.compilerCache = false;
	if (entry.build?.prebuiltReactNative === false) project.prebuiltReactNative = false;
	if (entry.fingerprint?.command !== undefined) project.fingerprintCommand = entry.fingerprint.command;
	if (entry.fingerprint?.include === "native+js" && entry.fingerprint.jsInputs) {
		project.jsInputs = entry.fingerprint.jsInputs;
	}
	const eas =
		entry.eas === false
			? undefined
			: (entry.eas ??
				(existsSync(join(root, "eas.json")) ? { profile: DEFAULT_EAS_PROFILE, trigger: false } : undefined));
	if (eas) project.eas = eas;
	return project;
}

/** Pick the project containing `start` (deepest root wins); a single project is picked regardless. */
export function selectProject(projects: readonly Project[], start: string, name?: string): Result<Project> {
	if (name !== undefined) {
		const named = projects.find((p) => p.name === name);
		return named
			? ok(named)
			: err(`no project "${name}" in ${CONFIG_FILE} (${projects.map((p) => p.name).join(", ")})`);
	}
	const containing = projects.filter((p) => within(p.root, start)).sort((a, b) => b.root.length - a.root.length);
	const [best] = containing;
	if (best) return ok(best);
	const [only, ...rest] = projects;
	if (only && rest.length === 0) return ok(only);
	return err(
		`several projects in ${CONFIG_FILE} and none contains ${start} — pass --project <dir> (${projects.map((p) => p.name).join(", ")})`
	);
}

const APP_CONFIG_FILES = ["app.config.ts", "app.config.js", "app.config.mjs", "app.config.cjs"] as const;

type AppJsonInfo = { name?: string; bundleId: Project["bundleId"] };

function readAppJson(path: string): Result<AppJsonInfo> {
	const raw = readJson(path);
	if (!raw.success) return raw;
	const parsed = configSchemas().appJsonSchema.safeParse(raw.data);
	const expo = parsed.success ? parsed.data.expo : undefined;
	const name = expo?.slug ?? expo?.name;
	const ios = expo?.ios?.bundleIdentifier;
	const android = expo?.android?.package;
	return ok({
		...(name ? { name } : {}),
		bundleId: { ...(ios ? { ios } : {}), ...(android ? { android } : {}) },
	});
}

function autoDetect(
	dir: string,
	env: Record<string, string | undefined>,
	bundleOverride: Project["bundleId"],
	appName?: string
): Result<Project> | undefined {
	const appJsonPath = join(dir, "app.json");
	const hasAppJson = existsSync(appJsonPath);
	const dynamic = APP_CONFIG_FILES.find((f) => existsSync(join(dir, f)));
	if (!hasAppJson && dynamic === undefined) return undefined;

	const info = hasAppJson ? readAppJson(appJsonPath) : ok<AppJsonInfo>({ bundleId: {} });
	if (!info.success) return info;
	const bundleId = { ...info.data.bundleId, ...bundleOverride };
	if (dynamic !== undefined && bundleId.ios === undefined && bundleId.android === undefined) {
		return err(
			`${join(dir, dynamic)} is dynamic — warden can't read its bundle id. Add ${CONFIG_FILE} (projects[].bundleId) or pass --bundle-id`
		);
	}
	const name = info.data.name ?? appName ?? dir.split(sep).at(-1) ?? "app";
	const project = fromConfig({ name, root: ".", bundleId }, dir, env);
	project.origin = hasAppJson ? "app.json" : "app.config";
	project.source = "auto";
	return ok(project);
}

export type LoadProjectInput = {
	/** `--project` dir or cwd */
	start: string;
	env: Record<string, string | undefined>;
	/** stop walking up here (git toplevel); default filesystem root */
	stopAt?: string;
	name?: string;
	/** `--bundle-id` for the requested platform */
	bundleId?: Project["bundleId"];
	/** `projects[].variants.<name>` to resolve the project with */
	variant?: string;
	/** a missing `variant` falls back to the project's own settings instead of erroring (`warden dev`) */
	variantOptional?: boolean;
	/** `<WARDEN_HOME>/projects/<key>/` (see `overlay.ts`): its config is used when the repo has none */
	overlayDir?: string;
	/** the app's slug when `app.json` has none (read from `expo config` for a dynamic `app.config.*`) */
	appName?: string;
};

/** `entry` with `variants.<name>` applied: each key the variant sets replaces the project's own. */
function applyVariant(
	entry: ParsedProjectConfig,
	name: string | undefined,
	optional: boolean
): Result<{ entry: ParsedProjectConfig; variant?: string }> {
	if (name === undefined) return ok({ entry });
	const variant = entry.variants?.[name];
	if (variant === undefined) {
		if (optional) return ok({ entry });
		const known = Object.keys(entry.variants ?? {});
		return err(
			`project "${entry.name}" has no variant "${name}"${known.length > 0 ? ` (${known.join(", ")})` : ""} — add projects[].variants.${name} to ${CONFIG_FILE}`
		);
	}
	return ok({ entry: { ...entry, ...variant }, variant: name });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Run a `warden.config.{ts,mts,js,mjs}` module (Bun transpiles it; type-only imports are erased) and
 * return its config: the default export, called with `context` when it is a function. Sync only, so
 * every caller stays sync.
 */
function readModule(path: string, context: WardenConfigContext): Result<unknown> {
	let mod: unknown;
	try {
		delete require.cache[path];
		mod = require(path);
	} catch (error) {
		return err(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const esm = extname(path) !== ".js";
	if (esm && !(isRecord(mod) && "default" in mod)) return err(`${path}: must \`export default\` a config`);
	let value = isRecord(mod) && "default" in mod ? mod.default : mod;
	if (typeof value === "function") {
		try {
			value = value(context);
		} catch (error) {
			return err(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (value instanceof Promise) {
		value.catch(() => undefined);
		return err(`${path}: the config must be sync (no async function / Promise)`);
	}
	return ok(value);
}

/** Is there a warden config file in `start` or a parent (to `stopAt`)? File names only: nothing is evaluated. */
export function hasRepoConfig(start: string, stopAt?: string): boolean {
	return ancestors(resolve(start), stopAt ? resolve(stopAt) : undefined).some((dir) =>
		CONFIG_FILES.some((f) => existsSync(join(dir, f)))
	);
}

/** The config in `dir` (undefined: none), parsed. A config function gets `{ configDir: dir, env }`. */
function readConfigIn(
	dir: string,
	env: Record<string, string | undefined>
): Result<{ config: ParsedWardenConfig } | undefined> {
	const files = CONFIG_FILES.filter((f) => existsSync(join(dir, f)));
	const [file, ...extra] = files;
	if (file === undefined) return ok(undefined);
	if (extra.length > 0) return err(`several warden configs in ${dir} (${files.join(", ")}) — keep one`);
	const path = join(dir, file);
	const raw = file === JSON_CONFIG_FILE ? readJson(path) : readModule(path, { configDir: dir, env });
	if (!raw.success) return raw;
	const config = parseWardenConfig(raw.data, basename(path));
	return config.success ? ok({ config: config.data }) : config;
}

/**
 * The nearest `warden.config.{ts,mts,js,mjs,json}` walking up from `start` (to `stopAt`), parsed;
 * undefined = none. Else the one in `overlayDir`, if given (project roots then resolve against the
 * checkout: `stopAt`, else `start`). A config function gets `{ configDir, env }`.
 */
export function findWardenConfig(
	start: string,
	stopAt?: string,
	env: Record<string, string | undefined> = process.env,
	overlayDir?: string
): Result<FoundConfig | undefined> {
	for (const dir of ancestors(resolve(start), stopAt ? resolve(stopAt) : undefined)) {
		const read = readConfigIn(dir, env);
		if (!read.success) return read;
		if (read.data) return ok({ dir, config: read.data.config, source: "repo", rootDir: dir });
	}
	if (overlayDir === undefined) return ok(undefined);
	const dir = resolve(overlayDir);
	const read = readConfigIn(dir, env);
	if (!read.success) return read;
	if (!read.data) return ok(undefined);
	return ok({ dir, config: read.data.config, source: "overlay", rootDir: resolve(stopAt ?? start) });
}

/** The configured project containing `start` (or `input.name`), resolved with `input.variant`. */
function configuredProject(
	projects: readonly ParsedProjectConfig[],
	configDir: string,
	start: string,
	input: LoadProjectInput,
	source: FoundConfig["source"]
): Result<Project> {
	const selected = selectProject(
		projects.map((p) => fromConfig(p, configDir, input.env)),
		start,
		input.name
	);
	if (!selected.success) return selected;
	const entry = projects.find((p) => p.name === selected.data.name);
	if (!entry) return err(`no project "${selected.data.name}" in ${CONFIG_FILE}`);
	const resolved = applyVariant(entry, input.variant, input.variantOptional === true);
	if (!resolved.success) return resolved;
	const project = fromConfig(resolved.data.entry, configDir, input.env);
	if (resolved.data.variant !== undefined) project.variant = resolved.data.variant;
	project.source = source;
	return ok(project);
}

/**
 * Find the project for `start`: nearest warden config walking up (to `stopAt`), else the
 * `overlayDir` config, else the nearest Expo app (`app.json` / `app.config.*`). `--bundle-id` overrides the configured id.
 */
export function loadProject(input: LoadProjectInput): Result<Project> {
	const start = resolve(input.start);
	const override = input.bundleId ?? {};
	const dirs = ancestors(start, input.stopAt ? resolve(input.stopAt) : undefined);
	const found = findWardenConfig(start, input.stopAt, input.env, input.overlayDir);
	if (!found.success) return found;
	const projects = found.data?.config.projects;
	if (found.data && projects) {
		const project = configuredProject(projects, found.data.rootDir, start, input, found.data.source);
		return project.success ? ok({ ...project.data, bundleId: { ...project.data.bundleId, ...override } }) : project;
	}
	for (const dir of dirs) {
		const detected = autoDetect(dir, input.env, override, input.appName);
		if (!detected) continue;
		if (input.variant !== undefined && input.variantOptional !== true && detected.success) {
			return err(`variant "${input.variant}" needs projects[].variants in a ${CONFIG_FILE}`);
		}
		return detected;
	}
	return err(`no ${CONFIG_FILE} (or ${JSON_CONFIG_FILE}), app.json or app.config.* found from ${start}`);
}

/**
 * The app dir `loadProject` would autodetect from `start` whose bundle id only Expo can read: no warden
 * config in reach, a dynamic `app.config.*`, and neither `app.json` nor `bundleOverride` names a bundle id.
 * Undefined otherwise. File names and `app.json` only: nothing is evaluated.
 */
export function dynamicAppConfigDir(
	start: string,
	stopAt: string | undefined,
	bundleOverride: Project["bundleId"] = {},
	overlayDir?: string
): string | undefined {
	if (hasRepoConfig(start, stopAt)) return undefined;
	if (overlayDir !== undefined && CONFIG_FILES.some((f) => existsSync(join(overlayDir, f)))) return undefined;
	if (bundleOverride.ios !== undefined || bundleOverride.android !== undefined) return undefined;
	for (const dir of ancestors(resolve(start), stopAt ? resolve(stopAt) : undefined)) {
		const dynamic = APP_CONFIG_FILES.find((f) => existsSync(join(dir, f)));
		const appJsonPath = join(dir, "app.json");
		const hasAppJson = existsSync(appJsonPath);
		if (!hasAppJson && dynamic === undefined) continue;
		if (dynamic === undefined) return undefined;
		const info = hasAppJson ? readAppJson(appJsonPath) : undefined;
		if (info !== undefined && !info.success) return undefined;
		const ids = info?.data.bundleId ?? {};
		return ids.ios === undefined && ids.android === undefined ? dir : undefined;
	}
	return undefined;
}

/** `start` and its parents, up to and including `stop` (or the filesystem root). */
function ancestors(start: string, stop: string | undefined): string[] {
	const out: string[] = [];
	for (let dir = start; ; dir = dirname(dir)) {
		out.push(dir);
		if (dir === stop || dirname(dir) === dir) return out;
	}
}

/** Where an Expo app config keeps each platform's id. */
const APP_CONFIG_BUNDLE_KEY: Record<Platform, string> = {
	ios: "expo.ios.bundleIdentifier",
	android: "expo.android.package",
};

export function bundleIdFor(project: Project, platform: Platform): Result<string> {
	const id = project.bundleId[platform];
	if (id) return ok(id);
	const fix =
		project.origin === "config"
			? `set bundleId.${platform} in ${CONFIG_FILE}`
			: `set ${APP_CONFIG_BUNDLE_KEY[platform]} in the app config (\`warden init --bundle-id <id>\` writes it)`;
	return err(`project "${project.name}" has no ${platform} bundle id — ${fix} or pass --bundle-id`);
}
