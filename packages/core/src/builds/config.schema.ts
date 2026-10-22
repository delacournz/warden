/**
 * The zod schemas of `warden.config.*` and `app.json`. `config.ts` loads this module on its first parse, not at
 * import: zod is ~95 modules, and `warden run` / `dev` / `app` start without a config to parse (15-2).
 */

import { z } from "zod";
import { e2eSuiteSchema } from "../affected/affected.schema";
import { batchPresetSchema, RESERVED_PRESET_NAMES } from "../batch/preset.schema";
import type { AppOption } from "./app-option.schema";
import { DEFAULT_EAS_PROFILE } from "./builds.defaults";

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
	/** false = don't opt iOS builds into React Native's precompiled core (RN 0.81-0.83 only; newer RN has it on by default) */
	prebuiltReactNative: z.boolean().optional(),
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
		/** default for every `e2e` suite and `batches` preset that doesn't set `headless` */
		headless: z.boolean().optional(),
		/** Android emulator settings */
		android: z
			.object({
				/** false = claims cold-boot the AVD instead of warden's quick-boot snapshot (`WARDEN_ANDROID_SNAPSHOT` overrides) */
				snapshot: z.boolean().optional(),
			})
			.strict()
			.optional(),
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

/** The slice of an Expo `app.json` warden reads (name, bundle ids). */
export const appJsonSchema = z.object({
	expo: z
		.object({
			name: z.string().optional(),
			slug: z.string().optional(),
			ios: z.object({ bundleIdentifier: z.string().optional() }).optional(),
			android: z.object({ package: z.string().optional() }).optional(),
		})
		.optional(),
});
