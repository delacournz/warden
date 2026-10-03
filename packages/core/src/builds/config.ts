import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import { e2eSuiteSchema } from "../affected/affected.schema";
import { batchPresetSchema, RESERVED_PRESET_NAMES } from "../batch/preset.schema";
import type { Platform } from "../types";
import {
	type BuildConfiguration,
	DEFAULT_EAS_PROFILE,
	defaultBuildCommand,
	LEGACY_CACHE_DIRS,
} from "./builds.defaults";

export const CONFIG_FILE = "warden.config.json";

const perPlatform = z.object({ ios: z.string().min(1).optional(), android: z.string().min(1).optional() }).strict();

export const projectConfigSchema = z
	.object({
		name: z.string().min(1),
		/** project dir relative to the config file */
		root: z.string().min(1).default("."),
		bundleId: perPlatform,
		/** own fingerprint command (`{platform}` is substituted); stdout = JSON `{ hash }` or a bare hash */
		fingerprint: z
			.object({ command: z.string().min(1) })
			.strict()
			.optional(),
		eas: z
			.object({
				profile: z.string().min(1).default(DEFAULT_EAS_PROFILE),
				workflow: z.string().min(1).optional(),
				trigger: z.boolean().default(false),
			})
			.strict()
			.optional(),
		build: perPlatform
			.extend({
				/** Xcode / Gradle configuration the local build produces; picks the default build command + where the artifact is searched */
				configuration: z.enum(["Debug", "Release"]).optional(),
			})
			.optional(),
		/** extra (legacy) cache roots laid out as `<dir>/<hash>/*.app|*.apk`, imported on demand */
		cacheDirs: z.array(z.string().min(1)).optional(),
	})
	.strict();

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
	});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type WardenConfig = z.infer<typeof wardenConfigSchema>;

export type EasSettings = { profile: string; workflow?: string; trigger: boolean };

/** A project ready for the build cache: absolute root, defaults applied. */
export type Project = {
	name: string;
	root: string;
	bundleId: { ios?: string; android?: string };
	fingerprintCommand?: string;
	/** undefined = EAS not used (no `eas` config and no `eas.json`) */
	eas?: EasSettings;
	build: Record<Platform, string>;
	/** Debug unless `build.configuration` says Release */
	buildConfiguration: BuildConfiguration;
	cacheDirs: string[];
	/** where the project came from */
	origin: "config" | "app.json" | "app.config";
};

export function parseWardenConfig(raw: unknown): Result<WardenConfig> {
	const parsed = wardenConfigSchema.safeParse(raw);
	if (parsed.success) return ok(parsed.data);
	const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
	return err(`invalid ${CONFIG_FILE}: ${issues}`);
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

function fromConfig(entry: ProjectConfig, configDir: string, env: Record<string, string | undefined>): Project {
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
	if (entry.fingerprint) project.fingerprintCommand = entry.fingerprint.command;
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
};

/** The nearest `warden.config.json` walking up from `start` (to `stopAt`), parsed; undefined = none. */
export function findWardenConfig(
	start: string,
	stopAt?: string
): Result<{ dir: string; config: WardenConfig } | undefined> {
	const dir = ancestors(resolve(start), stopAt ? resolve(stopAt) : undefined).find((d) =>
		existsSync(join(d, CONFIG_FILE))
	);
	if (dir === undefined) return ok(undefined);
	const raw = readJson(join(dir, CONFIG_FILE));
	if (!raw.success) return raw;
	const config = parseWardenConfig(raw.data);
	return config.success ? ok({ dir, config: config.data }) : config;
}

/**
 * Find the project for `start`: nearest `warden.config.json` walking up (to `stopAt`), else the
 * nearest Expo app (`app.json` / `app.config.*`). `--bundle-id` overrides the configured id.
 */
export function loadProject(input: LoadProjectInput): Result<Project> {
	const start = resolve(input.start);
	const override = input.bundleId ?? {};
	const dirs = ancestors(start, input.stopAt ? resolve(input.stopAt) : undefined);
	const found = findWardenConfig(start, input.stopAt);
	if (!found.success) return found;
	const projects = found.data?.config.projects;
	if (found.data && projects) {
		const configDir = found.data.dir;
		const project = selectProject(
			projects.map((p) => fromConfig(p, configDir, input.env)),
			start,
			input.name
		);
		return project.success ? ok({ ...project.data, bundleId: { ...project.data.bundleId, ...override } }) : project;
	}
	for (const dir of dirs) {
		const detected = autoDetect(dir, input.env, override);
		if (detected) return detected;
	}
	return err(`no ${CONFIG_FILE}, app.json or app.config.* found from ${start}`);
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
