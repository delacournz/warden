/**
 * What a pull request has to pass before it can merge into `develop`, and which of it a given diff
 * actually needs.
 *
 * Pull requests are gated on commit statuses written from the authoring machine by
 * `scripts/signoff/signoff.ts`, not on GitHub Actions jobs. Every check here had already run locally
 * (prek, `bun test`, the agent that wrote the change) and then ran a second time on billed macOS
 * runners. `ci.yml` is now `workflow_dispatch`-only: the escape hatch for a machine that cannot run a
 * check, which writes the same statuses from CI (see AGENTS.md § Signoff).
 *
 * Two kinds of check, and the difference is the whole design:
 *
 *   `always: true`  — typecheck / check / test. Nothing can change without them being relevant, so
 *                     they run on every pull request.
 *   `always: false` — `native` (warden-simd). Path-gated, so most pull requests never run it.
 *
 * Only the umbrella `signoff` context is required by `develop`'s branch protection (`gh signoff
 * install`). The sub-contexts are written for the checks panel but gate nothing on their own:
 * `signoff.ts` withholds the umbrella unless every check the diff made applicable ran and passed, so
 * a path-gated or always-on check still blocks the merge — transitively. A required context that
 * never arrives would leave a pull request unmergeable forever, which is why the required list is
 * static and minimal.
 */

/** One process to spawn. `cwd` is repo-root-relative; omitted means the repo root. */
export type SignoffCommand = { argv: readonly string[]; cwd?: string };

export type SignoffCheck = {
	/** Status context, published as `signoff/<context>`. */
	context: string;
	/** Human label for the plan and the report. */
	label: string;
	/** Runs on every pull request. */
	always: boolean;
	/** Glob patterns against repo-relative changed paths. Empty means "always applicable". */
	paths: readonly string[];
	/** The workflow that still runs this check on `workflow_dispatch`, for the escape hatch. */
	workflow: string;
	run: readonly SignoffCommand[];
	/**
	 * Resources this check holds for its whole run; `signoff.ts` never runs two checks naming the
	 * same one at once (see ./signoff-pool.ts).
	 */
	locks?: readonly string[];
};

/** The bare context branch protection requires. Emitted last, and only when everything passed. */
export const UMBRELLA_CONTEXT = "signoff";

export const SIGNOFF_CHECKS: readonly SignoffCheck[] = [
	{
		context: "typecheck",
		label: "typecheck",
		always: true,
		paths: [],
		workflow: "ci.yml",
		run: [{ argv: ["bunx", "turbo", "typecheck"] }],
	},
	{
		context: "check",
		label: "check (lint + format)",
		always: true,
		paths: [],
		workflow: "ci.yml",
		run: [{ argv: ["bunx", "turbo", "check"] }],
	},
	{
		context: "test",
		label: "test",
		always: true,
		paths: [],
		workflow: "ci.yml",
		run: [{ argv: ["bunx", "turbo", "test"] }],
	},
	{
		context: "native",
		label: "native (warden-simd)",
		always: false,
		paths: ["packages/e2e/native/**"],
		workflow: "ci.yml",
		// Swift, links idb's library package: deps (pinned idb tarball) + build + swift test against
		// fixtures, no simulator. macOS only.
		run: [
			{ argv: ["bun", "run", "--cwd", "packages/e2e", "native:deps"] },
			{ argv: ["bun", "run", "--cwd", "packages/e2e", "native:build"] },
			{ argv: ["swift", "test", "--package-path", "packages/e2e/native/ios"] },
		],
		// SwiftPM holds an exclusive lock on its build dir; never two Swift builds at once.
		locks: ["swiftpm"],
	},
];

/** The always-on contexts, in declaration order. */
export const ALWAYS_CONTEXTS: readonly string[] = SIGNOFF_CHECKS.filter((check) => check.always).map(
	(check) => check.context
);

/** Exactly what `develop`'s branch protection must require — see the header. */
export const REQUIRED_CONTEXTS: readonly string[] = [UMBRELLA_CONTEXT];

export type PlannedCheck = {
	check: SignoffCheck;
	applicable: boolean;
	/** Why it was skipped. Empty when applicable. */
	reason: string;
	/** Skipped by `--only` / `--skip` although the diff needed it. Withholds the umbrella. */
	filtered: boolean;
};

/** Files that can never affect a path-gated check. Nothing here imports a markdown file. */
const IGNORED_PATHS = ["**/*.md"] as const;

/** Whether any changed path matches any of the check's globs. */
function matches(changed: readonly string[], patterns: readonly string[]): boolean {
	const globs = patterns.map((pattern) => new Bun.Glob(pattern));
	return changed.some((file) => globs.some((glob) => glob.match(file)));
}

/**
 * Resolve a changed-file list into the full check plan — every check, applicable or not, so the
 * report can state what was skipped and why rather than silently omitting it.
 */
export function planChecks(changed: readonly string[]): PlannedCheck[] {
	const ignored = IGNORED_PATHS.map((pattern) => new Bun.Glob(pattern));
	const relevant = changed.filter((file) => !ignored.some((glob) => glob.match(file)));
	return SIGNOFF_CHECKS.map((check) => {
		if (check.always || matches(relevant, check.paths)) {
			return { check, applicable: true, reason: "", filtered: false };
		}
		return { check, applicable: false, reason: `no files matched ${check.paths.join(", ")}`, filtered: false };
	});
}

export type CheckFilters = { only: readonly string[]; skip: readonly string[] };

/**
 * Apply `--only` / `--skip`. Excluding a check the diff needed marks it `filtered`, so the run can
 * still write the sub-contexts that passed but never the umbrella: a partial run is not a signoff.
 */
export function applyFilters(plan: readonly PlannedCheck[], filters: CheckFilters): PlannedCheck[] {
	return plan.map((entry) => {
		if (!entry.applicable) return entry;
		if (filters.only.length > 0 && !filters.only.includes(entry.check.context)) {
			return { ...entry, applicable: false, filtered: true, reason: "excluded by --only" };
		}
		if (filters.skip.includes(entry.check.context)) {
			return { ...entry, applicable: false, filtered: true, reason: "excluded by --skip" };
		}
		return entry;
	});
}
