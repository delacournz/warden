import type { E2eReportJson } from "./contracts/e2e-report.schema";
import type { CallOptions, Platform } from "./sdk.types";

/** Why a spec was selected (mirrors `warden affected --json`). */
export type SpecReason =
	| { kind: "run-all"; file: string; pattern: string }
	| { kind: "path"; file: string; pattern: string }
	| { kind: "import"; file: string; chain: string[] }
	| { kind: "spec-file"; file: string }
	| { kind: "always"; pattern: string }
	| { kind: "unmapped" }
	| { kind: "all" }
	| { kind: "requested"; pattern: string }
	| { kind: "unmatched"; file: string };

/** One spec of a suite. */
export type SpecInfo = {
	/** the id `specs.run({ specs })` and `warden e2e --specs` take */
	id: string;
	/** absolute path of the `*.e2e.ts` file */
	file: string;
	/** a failure of a required spec fails the gate (default true) */
	required: boolean;
	/** platforms the spec runs on */
	platforms: Platform[];
};

/** One `e2e.<suite>` of `warden.config.ts` and its specs. */
export type SuiteInfo = {
	name: string;
	/** the suite's platform, undefined: both */
	platform?: Platform;
	/** the `projects[].name` the suite belongs to */
	project?: string;
	/** git ref the diff is taken against */
	base: string;
	/** absolute directory the suite's specs live in */
	specsDir: string;
	/** true for the default suite of an app that configures none */
	implicit: boolean;
	specs: SpecInfo[];
	warnings: string[];
};

export type SpecsListParams = {
	/** only this suite (`not_found` when it does not exist) */
	suite?: string;
	/** only the suites of this `projects[].name` */
	project?: string;
};

export type SpecsAffectedParams = {
	/** `e2e.<name>`; optional when the config has exactly one suite */
	suite?: string;
	/** git ref to diff against (default: the suite's `base`) */
	base?: string;
	/** default: the suite's platform, else both */
	platform?: Platform;
	/** use these changed files (relative to the working directory) instead of `git diff` */
	files?: readonly string[];
	/** the suite must belong to this `projects[].name` */
	project?: string;
};

export type SpecSelectionEntry = { id: string; file: string; required: boolean; reasons: SpecReason[] };

/** What one platform must run. */
export type SpecSelection = {
	platform: Platform;
	selected: SpecSelectionEntry[];
	/** runnable specs nothing selected */
	skipped: string[];
	/** changed files that reached no spec */
	unreached: string[];
	warnings: string[];
};

export type SpecsAffectedResult = {
	suite: string;
	base?: string;
	changes: Array<{ path: string; status: string; from?: string }>;
	platforms: SpecSelection[];
	warnings: string[];
};

/** Progress of a `specs.run`: the runner's own output, one line at a time. */
export type SpecEvent = { kind: "log"; line: string };

export type SpecsRunParams = {
	suite?: string;
	/** run exactly these spec ids / globs, skipping the git diff */
	specs?: readonly string[];
	/** run every spec of the suite (after include / exclude) */
	all?: boolean;
	/** git ref to diff against when neither `specs` nor `all` is given */
	base?: string;
	platform?: Platform;
	/** `projects[].name` to install the app from */
	project?: string;
	/** retries per failed spec */
	retry?: number;
	onEvent?: (event: SpecEvent) => void;
};

export type SpecsNamespace = {
	/** Suites of `warden.config.ts` with their specs. */
	list(params?: SpecsListParams, opts?: CallOptions): Promise<SuiteInfo[]>;
	/** The specs a change needs, with the reason for each (pure, in-process; same engine as `warden affected`). */
	affected(params?: SpecsAffectedParams, opts?: CallOptions): Promise<SpecsAffectedResult>;
	/**
	 * Run a suite through the CLI's own `warden e2e --json` and return its report. A failed gate still resolves
	 * (`report.ok === false`); an aborted signal kills the run (`interrupted`). Needs the `warden` CLI
	 * (`WardenClientOptions.cliCommand`).
	 */
	run(params: SpecsRunParams, opts?: CallOptions): Promise<E2eReportJson>;
};

/** Output of one CLI invocation. */
export type CliOutput = { exitCode: number; stdout: string; stderr: string };

/** Seam: how the CLI is run (default: `Bun.spawn`). */
export type SpecsDeps = {
	spawn(
		argv: readonly string[],
		o: {
			cwd: string;
			env: Record<string, string | undefined>;
			signal?: AbortSignal;
			onStderrLine: (line: string) => void;
		}
	): Promise<CliOutput>;
};
