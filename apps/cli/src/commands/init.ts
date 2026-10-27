import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DEFAULT_SPECS_DIR } from "@delacour/warden-core/affected/affected.defaults";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { expoInstallCommand, missingPackages } from "../expo-app";
import { emit, note, reportError, success, warn } from "../output";
import { currentBuild } from "../update/build-info";
import { projectStart } from "./app";
import { type InitApp, SMOKE_SPEC_SOURCE, wardenConfigSource } from "./init.data";

type InitOpts = { project?: string; bundleId?: string; force?: true; dryRun?: true; json?: true };

const APP_CONFIG_FILES = ["app.config.ts", "app.config.js", "app.config.mjs", "app.config.cjs"];
const WARDEN_CONFIG_FILES = [
	"warden.config.ts",
	"warden.config.mts",
	"warden.config.js",
	"warden.config.mjs",
	"warden.config.json",
];
const TS_SPEC = /\.e2e\.tsx?$/;

const appJsonSchema = z.looseObject({
	expo: z
		.looseObject({
			name: z.string().optional(),
			slug: z.string().optional(),
			ios: z.looseObject({ bundleIdentifier: z.string().optional() }).optional(),
			android: z.looseObject({ package: z.string().optional() }).optional(),
		})
		.optional(),
});

type AppJson = z.infer<typeof appJsonSchema>;

/** `app.json` of `root` (undefined: the app only has a dynamic `app.config.*`). */
function readAppJson(root: string): Result<AppJson | undefined> {
	const path = join(root, "app.json");
	if (!existsSync(path)) {
		return APP_CONFIG_FILES.some((f) => existsSync(join(root, f)))
			? ok(undefined)
			: err(`no app.json / app.config.* in ${root} — run in the Expo app's root or pass --project <dir>`);
	}
	try {
		const parsed = appJsonSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
		return parsed.success ? ok(parsed.data) : err(`${path}: not an Expo app.json`);
	} catch (error) {
		return err(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** `appJson` with `id` filled in for the platforms that have none; undefined when nothing changes. */
function withBundleId(appJson: AppJson, id: string | undefined): AppJson | undefined {
	const expo = appJson.expo ?? {};
	if (id === undefined || (expo.ios?.bundleIdentifier && expo.android?.package)) return undefined;
	return {
		...appJson,
		expo: {
			...expo,
			ios: { ...expo.ios, bundleIdentifier: expo.ios?.bundleIdentifier ?? id },
			android: { ...expo.android, package: expo.android?.package ?? id },
		},
	};
}

type Plan = {
	app: InitApp;
	/** relative path → content, in write order */
	files: Array<{ path: string; content: string; exists: boolean }>;
	/** rewritten `app.json`, when `--bundle-id` filled in a missing id */
	appJson?: string;
};

const hasSpecs = (dir: string): boolean =>
	existsSync(dir) && readdirSync(dir, { recursive: true }).some((entry) => TS_SPEC.test(String(entry)));

/** What init would write for the app in `root`. */
function plan(root: string, opts: InitOpts): Result<Plan> {
	const read = readAppJson(root);
	if (!read.success) return read;
	const updated = read.data ? withBundleId(read.data, opts.bundleId) : undefined;
	const expo = (updated ?? read.data)?.expo;
	const ios = expo?.ios?.bundleIdentifier ?? opts.bundleId;
	const android = expo?.android?.package ?? opts.bundleId;
	const bundleId = { ...(ios ? { ios } : {}), ...(android ? { android } : {}) };
	if (ios === undefined && android === undefined)
		return err("the app has no bundle id yet — pass --bundle-id <id> (e.g. com.example.app; written to app.json)");
	const app: InitApp = { name: expo?.slug ?? expo?.name ?? basename(root), bundleId };
	// a config in another format is the user's: never replaced by the .ts starter
	const foreign = WARDEN_CONFIG_FILES.find((f) => f !== "warden.config.ts" && existsSync(join(root, f)));
	const smoke = join(DEFAULT_SPECS_DIR, "smoke.e2e.ts");
	const files = [
		...(foreign ? [] : [{ path: "warden.config.ts", content: wardenConfigSource(app) }]),
		...(hasSpecs(join(root, DEFAULT_SPECS_DIR)) ? [] : [{ path: smoke, content: SMOKE_SPEC_SOURCE }]),
	].map((file) => ({ ...file, exists: existsSync(join(root, file.path)) }));
	return ok({ app, files, ...(updated ? { appJson: `${JSON.stringify(updated, null, 2)}\n` } : {}) });
}

/**
 * Install commands for what `warden dev` / `warden e2e` need and the app doesn't list.
 * `@delacour/warden-e2e` is pinned to this warden's version: the spec preload refuses any other.
 */
function installCommands(root: string): string[] {
	const dev = missingPackages(root, ["expo-dev-client"]);
	const e2e = missingPackages(root, ["@delacour/warden-e2e"]);
	return [
		...(dev.length > 0 ? [expoInstallCommand(root, dev).join(" ")] : []),
		...(e2e.length > 0 ? [`bun add -d ${e2e.map((name) => `${name}@${currentBuild().version}`).join(" ")}`] : []),
	];
}

/**
 * `warden init`: make an Expo app ready for `warden dev` / `warden e2e`. Writes the bundle id into
 * `app.json` when it has none (`--bundle-id`), a starter `warden.config.ts` and a first
 * `@delacour/warden-e2e` spec. Existing files are kept unless `--force`; packages are never installed,
 * only named.
 */
function init(ctx: CommandContext, opts: InitOpts): number {
	const fail = (message: string) => {
		reportError(ctx, "init", message);
		return 1;
	};
	const start = projectStart(ctx, opts.project);
	if (!start.success) return fail(start.error);
	const root = start.data;
	const planned = plan(root, opts);
	if (!planned.success) return fail(planned.error);
	const { files, appJson } = planned.data;
	const dry = opts.dryRun === true;
	const verb = dry ? "would write" : "wrote";
	const write = (path: string, content: string) => {
		if (!dry) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), content);
		}
		(dry ? note : success)(ctx, `warden init: ${verb} ${path}`);
	};
	if (appJson !== undefined) write("app.json", appJson);
	const written: string[] = [];
	const skipped: string[] = [];
	for (const file of files) {
		if (file.exists && !opts.force) {
			skipped.push(file.path);
			note(ctx, `warden init: kept ${file.path} (--force overwrites)`);
			continue;
		}
		write(file.path, file.content);
		written.push(file.path);
	}
	const install = installCommands(root);
	for (const command of install) warn(ctx, `warden init: install first: ${command}`);
	note(ctx, "warden init: next: warden dev (dev client + Metro on a leased simulator), warden e2e (the e2e/ specs)");
	if (opts.json) emit(ctx, true, { root, written, skipped, install }, "");
	return 0;
}

export const initCommand: Command = defineCommand({
	name: "init",
	group: "Setup",
	summary: "set an Expo app up for warden dev / warden e2e (warden.config.ts, a first spec)",
	register: (cmd, ctx, done) => {
		cmd
			.option("--project <dir>", "the Expo app's directory (default: cwd)")
			.option("--bundle-id <id>", "bundle id / package for an app that has none yet (written to app.json)")
			.option("--force", "overwrite files that already exist")
			.option("--dry-run", "print what would be written, write nothing")
			.option("--json", "machine-readable output")
			.addHelpText("after", "\nExample:\n  warden init --bundle-id com.example.app")
			.action((opts) => done(init(ctx, opts)));
	},
});
