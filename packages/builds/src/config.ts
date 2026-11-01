import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BuildKind } from "@delacour/warden-config/build-kinds";
import { DEFAULT_EAS_PROFILE } from "@delacour/warden-config/config.defaults";
import type { projectConfigSchema, wardenConfigSchema } from "@delacour/warden-config/config.schema";
import type { WardenConfigContext } from "@delacour/warden-config/define-config";
import type { Platform } from "@delacour/warden-store/types";
import { type WardenError, wardenErrors } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { z } from "zod";
import { type BuildConfiguration, buildDefaults, LEGACY_CACHE_DIRS } from "./builds.defaults";
import type { BuildTarget, ProjectKinds } from "./kinds";
import { type AppFramework, nativeIds } from "./native-ids";

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
	/** `projects[].kinds`: per-kind overrides of the built-in dev / simulator / release builds (see `kinds.ts`) */
	kinds?: ProjectKinds;
	/** set by `projectForKind`: the kind this project is resolved as; undefined = the kind-less flow */
	kind?: BuildKind;
	/** set by `projectForKind` for a build signed for a physical iPhone; undefined = a simulator / emulator build */
	target?: BuildTarget;
	/** `projects[].ios.device.bundleIdentifier`: replaces the bundle id of builds for a physical iPhone (and the app's id there) */
	iosDeviceBundleId?: string;
	/** set by `projectForKind`: env of the local build (`kinds.<kind>.env`) */
	buildEnv?: Record<string, string>;
	cacheDirs: string[];
	/** `expo` (expo start + a dev client) or bare `react-native` (react-native start, the app itself) */
	framework: AppFramework;
	/** where the project came from; `react-native` = autodetected from a bare app's package.json + native projects */
	origin: "config" | "app.json" | "app.config" | "react-native";
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

const APP_CONFIG_FILES = ["app.config.ts", "app.config.js", "app.config.mjs", "app.config.cjs"] as const;

type AppJsonInfo = { name?: string; bundleId: Project["bundleId"] };

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

/** Dirs searched below a root that has no `package.json` workspaces. */
const DEFAULT_APP_GLOBS = ["apps/*", "packages/*"] as const;

/** Where an Expo app config keeps each platform's id. */
const APP_CONFIG_BUNDLE_KEY: Record<Platform, string> = {
	ios: "expo.ios.bundleIdentifier",
	android: "expo.android.package",
};

/** Where a bare React Native app keeps each platform's id. */
const NATIVE_BUNDLE_KEY: Record<Platform, string> = {
	ios: "PRODUCT_BUNDLE_IDENTIFIER in ios/*.xcodeproj",
	android: "applicationId in android/app/build.gradle",
};

/** Project config lookup and loading: warden config files, app.json autodetect, monorepo workspaces. Singleton `projectConfig`. */
export class ProjectConfig {
	/**
	 * The zod schemas (`config.schema.ts`), loaded on the first parse: zod is ~95 modules that `run` / `dev` / `app` would
	 * otherwise load at start (15-2). `require`, not `import()`: `load` and `find` are synchronous.
	 */
	private schemas: typeof import("@delacour/warden-config/config.schema") | undefined;

	private configSchemas(): typeof import("@delacour/warden-config/config.schema") {
		this.schemas ??=
			require("@delacour/warden-config/config.schema") as typeof import("@delacour/warden-config/config.schema");
		return this.schemas;
	}

	/** Validate a config value; `file` names it in the error. */
	parse(raw: unknown, file: string = CONFIG_FILE): Result<ParsedWardenConfig> {
		const parsed = this.configSchemas().wardenConfigSchema.safeParse(raw);
		if (parsed.success) return resultFactory.ok(parsed.data);
		const issues = parsed.error.issues
			.map((i) => {
				const where = i.path.join(".") || "(root)";
				// a message that already names its path (a removed key's migration hint) is not prefixed twice
				return i.message.startsWith(where) ? i.message : `${where}: ${i.message}`;
			})
			.join("; ");
		return resultFactory.err(`invalid ${file}: ${issues}`);
	}

	private expandHome(path: string, home: string | undefined): string {
		return path === "~" || path.startsWith("~/") ? join(home ?? "~", path.slice(1)) : path;
	}

	private readJson(path: string): Result<unknown> {
		try {
			return resultFactory.ok(JSON.parse(readFileSync(path, "utf8")));
		} catch (error) {
			return resultFactory.err(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private within(dir: string, target: string): boolean {
		const rel = relative(dir, target);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	}

	/** The settings a project only carries when its config sets them. */
	private applyOptional(project: Project, entry: ParsedProjectConfig): void {
		if (entry.build?.cache === false) project.compilerCache = false;
		if (entry.build?.prebuiltReactNative === false) project.prebuiltReactNative = false;
		if (entry.kinds !== undefined) project.kinds = entry.kinds;
		if (entry.ios?.device?.bundleIdentifier !== undefined)
			project.iosDeviceBundleId = entry.ios.device.bundleIdentifier;
		if (entry.fingerprint?.command !== undefined) project.fingerprintCommand = entry.fingerprint.command;
		if (entry.fingerprint?.include === "native+js" && entry.fingerprint.jsInputs) {
			project.jsInputs = entry.fingerprint.jsInputs;
		}
	}

	private fromConfig(entry: ParsedProjectConfig, configDir: string, env: Record<string, string | undefined>): Project {
		const root = resolve(configDir, entry.root);
		const configuration = entry.build?.configuration ?? "Debug";
		const framework = entry.framework ?? nativeIds.appFramework(root) ?? "expo";
		const project: Project = {
			name: entry.name,
			root,
			bundleId: entry.bundleId,
			framework,
			build: {
				ios: entry.build?.ios ?? buildDefaults.defaultCommand("ios", configuration, framework),
				android: entry.build?.android ?? buildDefaults.defaultCommand("android", configuration, framework),
			},
			buildConfiguration: configuration,
			cacheDirs: (entry.cacheDirs ?? LEGACY_CACHE_DIRS[entry.name] ?? []).map((d) =>
				resolve(root, this.expandHome(d, env.HOME))
			),
			origin: "config",
			source: "repo",
		};
		this.applyOptional(project, entry);
		const eas =
			entry.eas === false
				? undefined
				: (entry.eas ??
					(existsSync(join(root, "eas.json")) ? { profile: DEFAULT_EAS_PROFILE, trigger: false } : undefined));
		if (eas) project.eas = eas;
		return project;
	}

	/** Pick the project containing `start` (deepest root wins); a single project is picked regardless. */
	selectProject(projects: readonly Project[], start: string, name?: string): Result<Project> {
		if (name !== undefined) {
			const named = projects.find((p) => p.name === name);
			return named
				? resultFactory.ok(named)
				: resultFactory.err(`no project "${name}" in ${CONFIG_FILE} (${projects.map((p) => p.name).join(", ")})`);
		}
		const containing = projects.filter((p) => this.within(p.root, start)).sort((a, b) => b.root.length - a.root.length);
		const [best] = containing;
		if (best) return resultFactory.ok(best);
		const [only, ...rest] = projects;
		if (only && rest.length === 0) return resultFactory.ok(only);
		return resultFactory.err(
			`several projects in ${CONFIG_FILE} and none contains ${start} — pass --project <dir> (${projects.map((p) => p.name).join(", ")})`
		);
	}

	private readAppJson(path: string): Result<AppJsonInfo> {
		const raw = this.readJson(path);
		if (!raw.success) return raw;
		const parsed = this.configSchemas().appJsonSchema.safeParse(raw.data);
		const expo = parsed.success ? parsed.data.expo : undefined;
		const name = expo?.slug ?? expo?.name;
		const ios = expo?.ios?.bundleIdentifier;
		const android = expo?.android?.package;
		return resultFactory.ok({
			...(name ? { name } : {}),
			bundleId: { ...(ios ? { ios } : {}), ...(android ? { android } : {}) },
		});
	}

	private autoDetect(
		dir: string,
		env: Record<string, string | undefined>,
		bundleOverride: Project["bundleId"],
		appName?: string
	): Result<Project> | undefined {
		const appJsonPath = join(dir, "app.json");
		const hasAppJson = existsSync(appJsonPath);
		const dynamic = APP_CONFIG_FILES.find((f) => existsSync(join(dir, f)));
		if (dynamic === undefined && nativeIds.appFramework(dir) === "react-native")
			return this.bareReactNative(dir, env, bundleOverride);
		if (!hasAppJson && dynamic === undefined) return undefined;

		const info = hasAppJson ? this.readAppJson(appJsonPath) : resultFactory.ok<AppJsonInfo>({ bundleId: {} });
		if (!info.success) return info;
		const bundleId = { ...info.data.bundleId, ...bundleOverride };
		if (dynamic !== undefined && bundleId.ios === undefined && bundleId.android === undefined) {
			return resultFactory.err(
				`${join(dir, dynamic)} is dynamic — warden can't read its bundle id. Add ${CONFIG_FILE} (projects[].bundleId) or pass --bundle-id`
			);
		}
		const name = info.data.name ?? appName ?? dir.split(sep).at(-1) ?? "app";
		const project = this.fromConfig({ name, root: ".", bundleId }, dir, env);
		project.origin = hasAppJson ? "app.json" : "app.config";
		project.source = "auto";
		return resultFactory.ok(project);
	}

	/** The app's own name: bare `app.json` `name` (what the template names the native targets), else package.json `name`. */
	private bareAppName(dir: string): string | undefined {
		for (const file of ["app.json", "package.json"]) {
			const raw = this.readJson(join(dir, file));
			if (raw.success && this.isRecord(raw.data) && typeof raw.data.name === "string" && raw.data.name !== "")
				return raw.data.name;
		}
		return undefined;
	}

	/** A bare React Native app (`react-native` without `expo`): ids from `ios/*.xcodeproj` and `android/app/build.gradle`. */
	private bareReactNative(
		dir: string,
		env: Record<string, string | undefined>,
		bundleOverride: Project["bundleId"]
	): Result<Project> {
		const name = this.bareAppName(dir) ?? basename(dir);
		const bundleId = { ...nativeIds.bundleIds(dir, name), ...bundleOverride };
		const project = this.fromConfig({ name, root: ".", bundleId, framework: "react-native" }, dir, env);
		project.origin = "react-native";
		project.source = "auto";
		return resultFactory.ok(project);
	}

	/** `entry` with `variants.<name>` applied: each key the variant sets replaces the project's own. */
	private applyVariant(
		entry: ParsedProjectConfig,
		name: string | undefined,
		optional: boolean
	): Result<{ entry: ParsedProjectConfig; variant?: string }> {
		if (name === undefined) return resultFactory.ok({ entry });
		const variant = entry.variants?.[name];
		if (variant === undefined) {
			if (optional) return resultFactory.ok({ entry });
			const known = Object.keys(entry.variants ?? {});
			return resultFactory.err(
				`project "${entry.name}" has no variant "${name}"${known.length > 0 ? ` (${known.join(", ")})` : ""} — add projects[].variants.${name} to ${CONFIG_FILE}`
			);
		}
		return resultFactory.ok({ entry: { ...entry, ...variant }, variant: name });
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null;
	}

	/**
	 * Run a `warden.config.{ts,mts,js,mjs}` module (Bun transpiles it; type-only imports are erased) and
	 * return its config: the default export, called with `context` when it is a function. Sync only, so
	 * every caller stays sync.
	 */
	private readModule(path: string, context: WardenConfigContext): Result<unknown> {
		let mod: unknown;
		try {
			delete require.cache[path];
			mod = require(path);
		} catch (error) {
			return resultFactory.err(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const esm = extname(path) !== ".js";
		if (esm && !(this.isRecord(mod) && "default" in mod))
			return resultFactory.err(`${path}: must \`export default\` a config`);
		let value = this.isRecord(mod) && "default" in mod ? mod.default : mod;
		if (typeof value === "function") {
			try {
				value = value(context);
			} catch (error) {
				return resultFactory.err(`${path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (value instanceof Promise) {
			value.catch(() => undefined);
			return resultFactory.err(`${path}: the config must be sync (no async function / Promise)`);
		}
		return resultFactory.ok(value);
	}

	/** Is there a warden config file in `start` or a parent (to `stopAt`)? File names only: nothing is evaluated. */
	hasRepoConfig(start: string, stopAt?: string): boolean {
		return this.ancestors(resolve(start), stopAt ? resolve(stopAt) : undefined).some((dir) =>
			CONFIG_FILES.some((f) => existsSync(join(dir, f)))
		);
	}

	/** The config in `dir` (undefined: none), parsed. A config function gets `{ configDir: dir, env }`. */
	private readConfigIn(
		dir: string,
		env: Record<string, string | undefined>
	): Result<{ config: ParsedWardenConfig } | undefined> {
		const files = CONFIG_FILES.filter((f) => existsSync(join(dir, f)));
		const [file, ...extra] = files;
		if (file === undefined) return resultFactory.ok(undefined);
		if (extra.length > 0) return resultFactory.err(`several warden configs in ${dir} (${files.join(", ")}) — keep one`);
		const path = join(dir, file);
		const raw = file === JSON_CONFIG_FILE ? this.readJson(path) : this.readModule(path, { configDir: dir, env });
		if (!raw.success) return raw;
		const config = this.parse(raw.data, basename(path));
		return config.success ? resultFactory.ok({ config: config.data }) : config;
	}

	/**
	 * The nearest `warden.config.{ts,mts,js,mjs,json}` walking up from `start` (to `stopAt`), parsed;
	 * undefined = none. Else the one in `overlayDir`, if given (project roots then resolve against the
	 * checkout: `stopAt`, else `start`). A config function gets `{ configDir, env }`.
	 */
	find(
		start: string,
		stopAt: string | undefined,
		env: Record<string, string | undefined>,
		overlayDir?: string
	): Result<FoundConfig | undefined> {
		for (const dir of this.ancestors(resolve(start), stopAt ? resolve(stopAt) : undefined)) {
			const read = this.readConfigIn(dir, env);
			if (!read.success) return read;
			if (read.data) return resultFactory.ok({ dir, config: read.data.config, source: "repo", rootDir: dir });
		}
		if (overlayDir === undefined) return resultFactory.ok(undefined);
		const dir = resolve(overlayDir);
		const read = this.readConfigIn(dir, env);
		if (!read.success) return read;
		if (!read.data) return resultFactory.ok(undefined);
		return resultFactory.ok({ dir, config: read.data.config, source: "overlay", rootDir: resolve(stopAt ?? start) });
	}

	/** The configured project containing `start` (or `input.name`), resolved with `input.variant`. */
	private configuredProject(
		projects: readonly ParsedProjectConfig[],
		configDir: string,
		start: string,
		input: LoadProjectInput,
		source: FoundConfig["source"]
	): Result<Project> {
		const selected = this.selectProject(
			projects.map((p) => this.fromConfig(p, configDir, input.env)),
			start,
			input.name
		);
		if (!selected.success) return selected;
		const entry = projects.find((p) => p.name === selected.data.name);
		if (!entry) return resultFactory.err(`no project "${selected.data.name}" in ${CONFIG_FILE}`);
		const resolved = this.applyVariant(entry, input.variant, input.variantOptional === true);
		if (!resolved.success) return resolved;
		const project = this.fromConfig(resolved.data.entry, configDir, input.env);
		if (resolved.data.variant !== undefined) project.variant = resolved.data.variant;
		project.source = source;
		return resultFactory.ok(project);
	}

	/**
	 * Find the project for `start`: nearest warden config walking up (to `stopAt`), else the
	 * `overlayDir` config, else the nearest Expo app (`app.json` / `app.config.*`). `--bundle-id` overrides the configured id.
	 */
	load(input: LoadProjectInput): Result<Project> {
		const start = resolve(input.start);
		const override = input.bundleId ?? {};
		const dirs = this.ancestors(start, input.stopAt ? resolve(input.stopAt) : undefined);
		const found = this.find(start, input.stopAt, input.env, input.overlayDir);
		if (!found.success) return found;
		const projects = found.data?.config.projects;
		if (found.data && projects) {
			const project = this.configuredProject(projects, found.data.rootDir, start, input, found.data.source);
			return project.success
				? resultFactory.ok({ ...project.data, bundleId: { ...project.data.bundleId, ...override } })
				: project;
		}
		for (const dir of dirs) {
			const detected = this.autoDetect(dir, input.env, override, input.appName);
			if (!detected) continue;
			if (input.variant !== undefined && input.variantOptional !== true && detected.success) {
				return resultFactory.err(`variant "${input.variant}" needs projects[].variants in a ${CONFIG_FILE}`);
			}
			return detected;
		}
		return this.projectBelow(input, start);
	}

	/** Nothing from `start` upwards: the one app below it (a monorepo root), else an error naming what was looked for. */
	private projectBelow(input: LoadProjectInput, start: string): Result<Project> {
		const below = this.appDirsBelow(start);
		const [only, ...more] = below;
		if (only !== undefined && more.length === 0) return this.load({ ...input, start: only });
		if (only !== undefined) {
			const names = below.map((d) => relative(start, d)).join(", ");
			return resultFactory.err(
				`several apps under ${start} (${names}) — run warden in one of them or pass --project <dir>`
			);
		}
		return resultFactory.err(
			`no ${CONFIG_FILE} (or ${JSON_CONFIG_FILE}), app.json or app.config.* found from ${start} or its workspaces`
		);
	}

	/** `package.json` `workspaces` (an array, or `{ packages }`), when `root` has one. */
	private workspaceGlobs(root: string): string[] | undefined {
		const raw = this.readJson(join(root, "package.json"));
		if (!raw.success || !this.isRecord(raw.data)) return undefined;
		const ws = raw.data.workspaces;
		const list = Array.isArray(ws) ? ws : this.isRecord(ws) && Array.isArray(ws.packages) ? ws.packages : undefined;
		return list?.filter((g): g is string => typeof g === "string");
	}

	/** Subdirs of `dir`, never `node_modules` or dot dirs. */
	private subdirs(dir: string): string[] {
		try {
			return readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
				.map((e) => join(dir, e.name))
				.sort();
		} catch {
			return [];
		}
	}

	/** The dirs a workspace glob names: literal segments, `*` / `**` = one level of any subdir. */
	private expandGlob(root: string, glob: string): string[] {
		let dirs = [root];
		for (const segment of glob.split("/").filter((s) => s !== "" && s !== ".")) {
			dirs =
				segment === "*" || segment === "**"
					? dirs.flatMap((d) => this.subdirs(d))
					: dirs.map((d) => join(d, segment)).filter((d) => existsSync(d));
		}
		return dirs;
	}

	/** Does `dir` hold a React Native app: an `app.json` / `app.config.*`, or a `react-native` dependency? */
	private isAppDir(dir: string): boolean {
		if (existsSync(join(dir, "app.json")) || APP_CONFIG_FILES.some((f) => existsSync(join(dir, f)))) return true;
		const raw = this.readJson(join(dir, "package.json"));
		if (!raw.success || !this.isRecord(raw.data)) return false;
		const { dependencies, devDependencies } = raw.data;
		return [dependencies, devDependencies].some((deps) => this.isRecord(deps) && "react-native" in deps);
	}

	/**
	 * The app dirs below `root` (a monorepo root): its `package.json` workspaces, else `apps/*` and
	 * `packages/*`, that hold a React Native app (`isAppDir`). Sorted, no duplicates.
	 */
	appDirsBelow(root: string): string[] {
		const start = resolve(root);
		const globs = this.workspaceGlobs(start) ?? [...DEFAULT_APP_GLOBS];
		const dirs = globs.filter((g) => !g.startsWith("!")).flatMap((g) => this.expandGlob(start, g));
		return [...new Set(dirs)].filter((d) => d !== start && this.isAppDir(d)).sort();
	}

	/** Is there a warden config or an app config in `start` or a parent (to `stopAt`), or an overlay config? */
	private projectAbove(start: string, stopAt: string | undefined, overlayDir: string | undefined): boolean {
		if (this.hasRepoConfig(start, stopAt)) return true;
		if (overlayDir !== undefined && CONFIG_FILES.some((f) => existsSync(join(overlayDir, f)))) return true;
		return this.ancestors(resolve(start), stopAt ? resolve(stopAt) : undefined).some(
			(dir) => existsSync(join(dir, "app.json")) || APP_CONFIG_FILES.some((f) => existsSync(join(dir, f)))
		);
	}

	/**
	 * Where the project lookup really starts: `start`, unless nothing is found from there upwards and
	 * exactly one app sits below it (a monorepo root), then that app's dir.
	 */
	appStart(start: string, stopAt?: string, overlayDir?: string): string {
		if (this.projectAbove(start, stopAt, overlayDir)) return resolve(start);
		const below = this.appDirsBelow(start);
		return below.length === 1 && below[0] !== undefined ? below[0] : resolve(start);
	}

	/** The apps below `start` to pick from, when nothing is found upwards and there are several; else empty. */
	appChoices(start: string, stopAt?: string, overlayDir?: string): string[] {
		if (this.projectAbove(start, stopAt, overlayDir)) return [];
		const below = this.appDirsBelow(start);
		return below.length > 1 ? below : [];
	}

	/**
	 * The app dir `loadProject` would autodetect from `start` whose bundle id only Expo can read: no warden
	 * config in reach, a dynamic `app.config.*`, and neither `app.json` nor `bundleOverride` names a bundle id.
	 * Undefined otherwise. File names and `app.json` only: nothing is evaluated.
	 */
	dynamicAppConfigDir(
		start: string,
		stopAt: string | undefined,
		bundleOverride: Project["bundleId"] = {},
		overlayDir?: string
	): string | undefined {
		if (this.hasRepoConfig(start, stopAt)) return undefined;
		if (overlayDir !== undefined && CONFIG_FILES.some((f) => existsSync(join(overlayDir, f)))) return undefined;
		if (bundleOverride.ios !== undefined || bundleOverride.android !== undefined) return undefined;
		for (const dir of this.ancestors(resolve(start), stopAt ? resolve(stopAt) : undefined)) {
			const found = this.dynamicIn(dir);
			if (found !== "none") return found;
		}
		return undefined;
	}

	/** `dir`'s verdict for `dynamicAppConfigDir`: `"none"` = no app config here, keep walking up; else the answer. */
	private dynamicIn(dir: string): string | undefined {
		const dynamic = APP_CONFIG_FILES.find((f) => existsSync(join(dir, f)));
		const appJsonPath = join(dir, "app.json");
		const hasAppJson = existsSync(appJsonPath);
		if (!hasAppJson && dynamic === undefined) return "none";
		if (dynamic === undefined) return undefined;
		const info = hasAppJson ? this.readAppJson(appJsonPath) : undefined;
		if (info !== undefined && !info.success) return undefined;
		const ids = info?.data.bundleId ?? {};
		return ids.ios === undefined && ids.android === undefined ? dir : undefined;
	}

	/** `start` and its parents, up to and including `stop` (or the filesystem root). */
	private ancestors(start: string, stop: string | undefined): string[] {
		const out: string[] = [];
		for (let dir = start; ; dir = dirname(dir)) {
			out.push(dir);
			if (dir === stop || dirname(dir) === dir) return out;
		}
	}

	bundleIdFor(project: Project, platform: Platform): Result<string, WardenError> {
		const id = project.bundleId[platform];
		if (id) return resultFactory.ok(id);
		const fix =
			project.origin === "config"
				? `set bundleId.${platform} in ${CONFIG_FILE}`
				: project.origin === "react-native"
					? `set ${NATIVE_BUNDLE_KEY[platform]}, add ${CONFIG_FILE} (projects[].bundleId)`
					: `set ${APP_CONFIG_BUNDLE_KEY[platform]} in the app config (\`warden init --bundle-id <id>\` writes it)`;
		return wardenErrors.err(
			"config_invalid",
			`project "${project.name}" has no ${platform} bundle id — ${fix} or pass --bundle-id`
		);
	}
}

export const projectConfig = new ProjectConfig();
