import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import { e2eSuiteSchema } from "../affected/affected.schema";
import { batchPresetSchema, RESERVED_PRESET_NAMES } from "../batch/preset.schema";
import type { Platform } from "../types";
import type { AppOption } from "./app-option.schema";
import {
	type BuildConfiguration,
	DEFAULT_EAS_PROFILE,
	defaultBuildCommand,
	LEGACY_CACHE_DIRS,
} from "./builds.defaults";
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

const perPlatform = z.object({ ios: z.string().min(1).optional(), android: z.string().min(1).optional() }).strict();

const fingerprintSchema = z
	.object({
		/** own fingerprint command (`{platform}` is substituted); stdout = JSON `{ hash }` or a bare hash */
		command: z.string().min(1).optional(),
		/** native: key = the native fingerprint; native+js: key also covers the `jsInputs` file contents (Release builds embed the JS) */
		include: z.enum(["native", "native+js"]).default("native"),
		/** globs (relative to the project root) of the JS sources that make up the bundle; git-tracked + untracked-not-ignored files only */
		jsInputs: z.array(z.string().min(1)).min(1).optional(),
	})
	.strict()
	.superRefine((fp, issue) => {
		if (fp.include === "native+js" && fp.jsInputs === undefined) {
			issue.addIssue({ code: "custom", message: 'include "native+js" needs jsInputs', path: ["jsInputs"] });
		}
		if (fp.include === "native" && fp.jsInputs !== undefined) {
			issue.addIssue({ code: "custom", message: 'jsInputs only apply to include "native+js"', path: ["jsInputs"] });
		}
	});

const easSchema = z
	.object({
		profile: z.string().min(1).default(DEFAULT_EAS_PROFILE),
		workflow: z.string().min(1).optional(),
		trigger: z.boolean().default(false),
	})
	.strict();

const buildSchema = perPlatform.extend({
	/** Xcode / Gradle configuration the local build produces; picks the default build command + where the artifact is searched */
	configuration: z.enum(["Debug", "Release"]).optional(),
	/** false = don't inject the shared compiler caches (ccache, Xcode compilation caching, Gradle build cache) into local builds */
	cache: z.boolean().optional(),
});

/** A named build of the project (`variants.<name>`): each key set here replaces the project's own. */
export const variantSchema = z
	.object({ fingerprint: fingerprintSchema.optional(), eas: easSchema.optional(), build: buildSchema.optional() })
	.strict();

export const projectConfigSchema = z
	.object({
		name: z.string().min(1),
		/** project dir relative to the config file */
		root: z.string().min(1).default("."),
		bundleId: perPlatform,
		fingerprint: fingerprintSchema.optional(),
		eas: easSchema.optional(),
		build: buildSchema.optional(),
		/** named builds (`dev`, `e2e`…) picked with `--variant` / `app.variant`; each replaces fingerprint / eas / build wholesale */
		variants: z.record(z.string().min(1), variantSchema).optional(),
		/** extra (legacy) cache roots laid out as `<dir>/<hash>/*.app|*.apk`, imported on demand */
		cacheDirs: z.array(z.string().min(1)).optional(),
	})
	.strict();

/** Why an e2e suite's `app.variant` is unknown on its project (the only one when it names none), if it is. */
function unknownSuiteVariant(
	projects: readonly z.infer<typeof projectConfigSchema>[],
	suite: { project?: string | undefined; app?: AppOption | undefined }
): string | undefined {
	const variant = typeof suite.app === "object" ? suite.app.variant : undefined;
	if (variant === undefined) return undefined;
	const name = suite.project;
	const project = name === undefined && projects.length === 1 ? projects[0] : projects.find((p) => p.name === name);
	if (!project || project.variants?.[variant] !== undefined) return undefined;
	return `no variant "${variant}" on project ${project.name}`;
}

type ConfigIssues = { addIssue: (issue: { code: "custom"; message: string; path: Array<string | number> }) => void };

/** e2e suites: `project` must exist, and so must `app.variant` on it. */
function refineSuites(
	config: {
		projects?: z.infer<typeof projectConfigSchema>[] | undefined;
		e2e?: Record<string, { project?: string | undefined; app?: AppOption | undefined }> | undefined;
	},
	issue: ConfigIssues
): void {
	const names = new Set((config.projects ?? []).map((p) => p.name));
	for (const [name, suite] of Object.entries(config.e2e ?? {})) {
		if (suite.project !== undefined && !names.has(suite.project)) {
			issue.addIssue({
				code: "custom",
				message: `no project "${suite.project}" in projects[]`,
				path: ["e2e", name, "project"],
			});
		}
		const variant = unknownSuiteVariant(config.projects ?? [], suite);
		if (variant !== undefined)
			issue.addIssue({ code: "custom", message: variant, path: ["e2e", name, "app", "variant"] });
	}
}

export const wardenConfigSchema = z
	.object({
		projects: z.array(projectConfigSchema).min(1).optional(),
		/** named `warden batch` presets */
		batches: z.record(z.string().min(1), batchPresetSchema).optional(),
		/** named `warden affected` / `warden e2e` suites */
		e2e: z.record(z.string().min(1), e2eSuiteSchema).optional(),
	})
	.strict()
	.superRefine((config, issue) => {
		if (config.projects === undefined && config.batches === undefined && config.e2e === undefined) {
			issue.addIssue({ code: "custom", message: "set projects, batches and/or e2e", path: [] });
		}
		const names = new Set((config.projects ?? []).map((p) => p.name));
		for (const [name, preset] of Object.entries(config.batches ?? {})) {
			if (RESERVED_PRESET_NAMES.includes(name)) {
				issue.addIssue({
					code: "custom",
					message: `"${name}" is a platform, pick another name`,
					path: ["batches", name],
				});
			}
			if (preset.project !== undefined && !names.has(preset.project)) {
				issue.addIssue({
					code: "custom",
					message: `no project "${preset.project}" in projects[]`,
					path: ["batches", name, "project"],
				});
			}
		}
		refineSuites(config, issue);
	});

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
	/** the `variants.<name>` this project was resolved with; undefined = the project's own settings */
	variant?: string;
	cacheDirs: string[];
	/** where the project came from */
	origin: "config" | "app.json" | "app.config";
};

/** Validate a config value; `file` names it in the error. */
export function parseWardenConfig(raw: unknown, file: string = CONFIG_FILE): Result<ParsedWardenConfig> {
	const parsed = wardenConfigSchema.safeParse(raw);
	if (parsed.success) return ok(parsed.data);
	const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
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
	};
	if (entry.build?.cache === false) project.compilerCache = false;
	if (entry.fingerprint?.command !== undefined) project.fingerprintCommand = entry.fingerprint.command;
	if (entry.fingerprint?.include === "native+js" && entry.fingerprint.jsInputs) {
		project.jsInputs = entry.fingerprint.jsInputs;
	}
	const eas =
		entry.eas ?? (existsSync(join(root, "eas.json")) ? { profile: DEFAULT_EAS_PROFILE, trigger: false } : undefined);
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

const appJsonSchema = z.object({
	expo: z
		.object({
			name: z.string().optional(),
			slug: z.string().optional(),
			ios: z.object({ bundleIdentifier: z.string().optional() }).optional(),
			android: z.object({ package: z.string().optional() }).optional(),
		})
		.optional(),
});

type AppJsonInfo = { name?: string; bundleId: Project["bundleId"] };

function readAppJson(path: string): Result<AppJsonInfo> {
	const raw = readJson(path);
	if (!raw.success) return raw;
	const parsed = appJsonSchema.safeParse(raw.data);
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
	bundleOverride: Project["bundleId"]
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
	const name = info.data.name ?? dir.split(sep).at(-1) ?? "app";
	const project = fromConfig({ name, root: ".", bundleId }, dir, env);
	project.origin = hasAppJson ? "app.json" : "app.config";
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

/**
 * The nearest `warden.config.{ts,mts,js,mjs,json}` walking up from `start` (to `stopAt`), parsed;
 * undefined = none. A config function gets `{ configDir, env }`.
 */
export function findWardenConfig(
	start: string,
	stopAt?: string,
	env: Record<string, string | undefined> = process.env
): Result<{ dir: string; config: ParsedWardenConfig } | undefined> {
	for (const dir of ancestors(resolve(start), stopAt ? resolve(stopAt) : undefined)) {
		const files = CONFIG_FILES.filter((f) => existsSync(join(dir, f)));
		const [file, ...extra] = files;
		if (file === undefined) continue;
		if (extra.length > 0) return err(`several warden configs in ${dir} (${files.join(", ")}) — keep one`);
		const path = join(dir, file);
		const raw = file === JSON_CONFIG_FILE ? readJson(path) : readModule(path, { configDir: dir, env });
		if (!raw.success) return raw;
		const config = parseWardenConfig(raw.data, basename(path));
		return config.success ? ok({ dir, config: config.data }) : config;
	}
	return ok(undefined);
}

/** The configured project containing `start` (or `input.name`), resolved with `input.variant`. */
function configuredProject(
	projects: readonly ParsedProjectConfig[],
	configDir: string,
	start: string,
	input: LoadProjectInput
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
	return ok(project);
}

/**
 * Find the project for `start`: nearest warden config walking up (to `stopAt`), else the
 * nearest Expo app (`app.json` / `app.config.*`). `--bundle-id` overrides the configured id.
 */
export function loadProject(input: LoadProjectInput): Result<Project> {
	const start = resolve(input.start);
	const override = input.bundleId ?? {};
	const dirs = ancestors(start, input.stopAt ? resolve(input.stopAt) : undefined);
	const found = findWardenConfig(start, input.stopAt, input.env);
	if (!found.success) return found;
	const projects = found.data?.config.projects;
	if (found.data && projects) {
		const project = configuredProject(projects, found.data.dir, start, input);
		return project.success ? ok({ ...project.data, bundleId: { ...project.data.bundleId, ...override } }) : project;
	}
	for (const dir of dirs) {
		const detected = autoDetect(dir, input.env, override);
		if (!detected) continue;
		if (input.variant !== undefined && input.variantOptional !== true && detected.success) {
			return err(`variant "${input.variant}" needs projects[].variants in a ${CONFIG_FILE}`);
		}
		return detected;
	}
	return err(`no ${CONFIG_FILE} (or ${JSON_CONFIG_FILE}), app.json or app.config.* found from ${start}`);
}

/** `start` and its parents, up to and including `stop` (or the filesystem root). */
function ancestors(start: string, stop: string | undefined): string[] {
	const out: string[] = [];
	for (let dir = start; ; dir = dirname(dir)) {
		out.push(dir);
		if (dir === stop || dirname(dir) === dir) return out;
	}
}

export function bundleIdFor(project: Project, platform: Platform): Result<string> {
	const id = project.bundleId[platform];
	return id
		? ok(id)
		: err(
				`project "${project.name}" has no ${platform} bundle id — set bundleId.${platform} in ${CONFIG_FILE} or pass --bundle-id`
			);
}
