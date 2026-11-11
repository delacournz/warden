import { homedir } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_PROFILE } from "@delacour/warden-core/config.defaults";
import { wardenHome } from "@delacour/warden-core/store";
import type { AsyncResult } from "@delacour/warden-types/result";
import { err, ok } from "@delacour/warden-types/result";
import {
	type CacheGroup,
	cacheGroups,
	DEFAULT_CACHE_PREFIX,
	DEFAULT_JS_INPUTS,
	jsInputsHash,
	runnerTag,
} from "../ci-cache";
import { resolveOwner } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { reportError } from "../output";
import { projectContextFor } from "../project-context";
import { withSpinner } from "../spinner-context";
import { projectStart } from "./app";

/** The slow facts a cache key is made of, injectable so tests need no Expo project or simulator runtime. */
export type CiDeps = {
	/** the simulator kind's native fingerprint of the project found from `dir` */
	nativeFingerprint: (ctx: CommandContext, dir: string) => AsyncResult<string>;
	/** the golden's name for `profile` (absent = warden's default) */
	goldenName: (ctx: CommandContext, profile: string | undefined) => AsyncResult<string>;
	/**
	 * Does the e2e suite found from `dir` (named, or the only one) clone from a golden? With no suite named, a
	 * config that does not pick one answers true, so the golden group stays.
	 */
	suiteGolden: (ctx: CommandContext, dir: string, suite: string | undefined) => AsyncResult<boolean>;
	/** Does the project found from `dir` build with warden's compiler caches (`build.cache` is not `false`)? */
	compilerCache: (ctx: CommandContext, dir: string) => AsyncResult<boolean>;
};

const defaultCiDeps: CiDeps = {
	async nativeFingerprint(ctx, dir) {
		const project = await projectContextFor(ctx, { start: dir });
		if (!project.success) return project;
		const { kindFingerprints } = await import("@delacour/warden-core/builds/kind-key");
		const fps = await kindFingerprints({
			exec: ctx.exec,
			project: project.data.project,
			platform: "ios",
			kind: "simulator",
			env: ctx.env,
			memo: { store: ctx.store(), now: ctx.now() },
		});
		return fps.success ? ok(fps.data.nativeFp) : fps;
	},
	async compilerCache(ctx, dir) {
		const project = await projectContextFor(ctx, { start: dir });
		return project.success ? ok(project.data.project.compilerCache !== false) : project;
	},
	async suiteGolden(ctx, dir, suite) {
		const { findSuite } = await import("@delacour/warden-core/affected/affected");
		const found = await findSuite(ctx.exec, dir, suite, ctx.git, ctx.env);
		if (found.success) return ok(found.data.golden);
		return suite === undefined ? ok(true) : err(found.error.message);
	},
	async goldenName(ctx, profile) {
		const { goldenInfo } = await import("@delacour/warden-core/golden/ios-golden-archive");
		const { goldenDeps } = await import("../golden-deps");
		const info = await goldenInfo(goldenDeps(ctx, resolveOwner(ctx)), profile ?? DEFAULT_PROFILE.ios, undefined);
		return info.success ? ok(info.data.name) : info;
	},
};

type CacheOpts = {
	platform?: string;
	project?: string;
	prefix?: string;
	profile?: string;
	jsInput?: string[];
	goldenDir?: string;
	suite?: string;
	json?: true;
};

function fail(ctx: CommandContext, error: string): number {
	reportError(ctx, "ci cache", error);
	return 1;
}

async function cacheCmd(ctx: CommandContext, deps: CiDeps, opts: CacheOpts): Promise<number> {
	if ((opts.platform ?? "ios") !== "ios") {
		return fail(ctx, `--platform must be ios, not "${opts.platform}": the cached builds and golden are iOS only`);
	}
	const start = projectStart(ctx, opts.project);
	if (!start.success) return fail(ctx, start.error);
	const dir = start.data;
	const facts = await withSpinner(ctx, "keying the CI caches…", async (sctx) => {
		const native = await deps.nativeFingerprint(sctx, dir);
		if (!native.success) return native;
		const js = await jsInputsHash(sctx.exec, dir, opts.jsInput ?? DEFAULT_JS_INPUTS);
		if (!js.success) return js;
		const ccache = await deps.compilerCache(sctx, dir);
		if (!ccache.success) return ccache;
		const base = { native: native.data, js: js.data, ccache: ccache.data };
		const enabled = await deps.suiteGolden(sctx, dir, opts.suite);
		if (!enabled.success) return enabled;
		if (!enabled.data) return ok({ ...base, golden: undefined });
		const golden = await deps.goldenName(sctx, opts.profile);
		if (!golden.success) return golden;
		return ok({ ...base, golden: golden.data });
	});
	if (!facts.success) return fail(ctx, facts.error);
	const home = ctx.env.HOME ?? homedir();
	const all = cacheGroups({
		prefix: opts.prefix ?? DEFAULT_CACHE_PREFIX,
		runner: runnerTag(ctx.env, ctx.os ?? process.platform, process.arch),
		nativeFingerprint: facts.data.native,
		js: facts.data.js,
		golden: facts.data.golden ?? "",
		wardenHome: wardenHome(ctx.env),
		goldenDir: opts.goldenDir === undefined ? resolve(home, "warden-goldens") : resolve(ctx.cwd, opts.goldenDir),
		...(opts.profile !== undefined ? { profile: opts.profile } : {}),
	});
	// a suite without golden: no group, so a CI job neither restores, builds nor saves one
	// `build.cache: false`: the build never calls ccache, so a CI job neither installs, restores nor saves it
	const groups = {
		...all,
		golden: facts.data.golden === undefined ? null : all.golden,
		ccache: facts.data.ccache ? all.ccache : null,
	};
	if (opts.json) {
		ctx.out(JSON.stringify(groups, null, 2));
		return 0;
	}
	const { color } = ctx.ui;
	const line = (name: string, group: CacheGroup): string => {
		const around =
			group.kind === "archive"
				? `\n  ${color.dim(`after restore: ${group.afterRestore}; before save: ${group.beforeSave}`)}`
				: "";
		const fallback =
			group.kind === "paths" && group.restoreKeys
				? `\n  ${color.dim(`on a miss, restore the newest of: ${group.restoreKeys.join(" ")}`)}`
				: "";
		return `${color.bold(name.padEnd(7))} ${group.key}\n  ${group.paths.join(" ")}${around}${fallback}`;
	};
	const golden = groups.golden
		? line("golden", groups.golden)
		: `${color.bold("golden ")} off (the suite creates fresh simulators)`;
	const ccache = groups.ccache ? line("ccache", groups.ccache) : `${color.bold("ccache ")} off (build.cache: false)`;
	ctx.out([line("builds", groups.builds), line("repack", groups.repack), golden, ccache].join("\n"));
	return 0;
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/** CI helpers: `ci cache` prints what a CI job caches between runs (keys, paths, and the golden's import/export). */
export function createCiCommand(deps: CiDeps = defaultCiDeps): Command {
	return defineCommand({
		name: "ci",
		group: "Builds",
		summary: "CI helpers: cache prints the cache keys and paths a CI job saves between runs",
		register: (cmd, ctx, done) => {
			cmd
				.command("cache")
				.description(
					"print the CI cache groups (builds, repack, golden, ccache): each key, its paths, and the golden's import/export commands"
				)
				.option("--platform <platform>", "ios (default; the only one with cacheable builds and a golden)")
				.option("--project <dir>", "project directory (default: cwd)")
				.option("--prefix <prefix>", `prefix of every key (default: ${DEFAULT_CACHE_PREFIX})`)
				.option("--profile <slug>", `device profile of the golden (default: ${DEFAULT_PROFILE.ios})`)
				.option(
					"--js-input <pathspec>",
					`git pathspec of the JS bundle's input, repeatable; keys the repack group (default: ${DEFAULT_JS_INPUTS.join(" ")})`,
					collect
				)
				.option("--golden-dir <dir>", "where the golden is archived (default: ~/warden-goldens)")
				.option(
					"--suite <name>",
					"e2e suite whose golden setting applies: golden is null unless it sets golden: true (default: the only suite)"
				)
				.option("--json", "machine-readable output")
				.action(async (o) => done(await cacheCmd(ctx, deps, o)));
		},
	});
}

export const ciCommand: Command = createCiCommand();
