import { z } from "zod";
import { duration, portSpec, slimConfigSchema } from "../batch/preset.schema";
import { appOptionSchema } from "../builds/app-option.schema";
import { conditionsConfigSchema } from "../conditions/conditions.config";
import { DEFAULT_JOB_TIMEOUT_MS, DEFAULT_METRO_PORT_SPEC, DEFAULT_METRO_READY_TIMEOUT } from "../config.defaults";
import { validateProfile } from "../sims/slim.profile";

const path = z.string().min(1);
const platform = z.enum(["ios", "android"]);

/** `e2e.<suite>.specs.<id|glob>`: what a spec covers and whether it gates. */
export const e2eSpecEntrySchema = z
	.object({
		/** files the spec drives (screens / routes); everything they import, transitively, selects the spec */
		entries: z.array(path).default([]),
		/** extra globs that select the spec when a changed file matches */
		paths: z.array(path).default([]),
		/** default: inferred from the spec id (`-ios-` / `-android-`), else both */
		platforms: z.array(platform).min(1).optional(),
		/** overrides the suite's `maxDepth` */
		maxDepth: z.number().int().min(0).optional(),
		/** a failure fails `warden e2e`; false = reported only */
		required: z.boolean().optional(),
	})
	.strict();

/** How a suite's spec processes are laid out: one per device running its share of the specs, or one per spec. */
export type E2eIsolation = "device" | "spec";

type RunSettings = {
	isolate?: E2eIsolation | undefined;
	passes: number;
	count?: number | undefined;
	profile?: string | undefined;
	devices?: Array<{ profile: string; default: boolean }> | undefined;
};

/**
 * The isolation a suite runs with: what it asked for (`isolate`), else one
 * process per device, except that `passes` > 1 needs a process per spec (a spec's passes are
 * re-runs of that spec).
 */
export function suiteIsolation(suite: Pick<RunSettings, "isolate" | "passes">): E2eIsolation {
	return suite.isolate ?? (suite.passes > 1 ? "spec" : "device");
}

/** What `isolate` and `devices` rule out. */
function runIssues(suite: RunSettings): Array<{ message: string; path: string[] }> {
	const issues: Array<{ message: string; path: string[] }> = [];
	if (suite.isolate === "device" && suite.passes > 1)
		issues.push({
			message: 'passes > 1 needs isolate "spec" (one process cannot be re-run per spec)',
			path: ["passes"],
		});
	const { devices } = suite;
	if (!devices) return issues;
	if (suite.count !== undefined || suite.profile !== undefined)
		issues.push({ message: "devices replaces profile / count", path: ["devices"] });
	const seen = new Set<string>();
	for (const leg of devices) {
		if (seen.has(leg.profile)) issues.push({ message: `duplicate profile "${leg.profile}"`, path: ["devices"] });
		seen.add(leg.profile);
	}
	if (!devices.some((leg) => leg.default))
		issues.push({ message: "at least one device leg must be a default one", path: ["devices"] });
	return issues;
}

/** What `physical` rules out: simulator daemon slimming, closing Simulator.app windows and simulated biometrics mean nothing on a real device. */
function physicalIssues(suite: {
	physical?: unknown;
	slim?: unknown;
	headless?: boolean | undefined;
	biometrics?: boolean | undefined;
	conditions?: unknown;
}): Array<{ message: string; path: string[] }> {
	if (suite.physical === undefined) return [];
	const issues: Array<{ message: string; path: string[] }> = [];
	if (suite.slim !== undefined && suite.slim !== false)
		issues.push({ message: "slim cannot be used with physical devices", path: ["slim"] });
	if (suite.headless === true)
		issues.push({ message: "headless cannot be used with physical devices", path: ["headless"] });
	if (suite.biometrics === true)
		issues.push({
			message: "biometrics cannot be used with physical devices (use a simulator or emulator suite)",
			path: ["biometrics"],
		});
	if (suite.conditions !== undefined)
		issues.push({
			message: "conditions cannot be used with physical devices (use a simulator or emulator suite)",
			path: ["conditions"],
		});
	return issues;
}

/** `e2e.<suite>.metro`: warden starts one Metro for the run and points the dev client at it. */
export const e2eMetroSchema = z
	.object({
		enabled: z.boolean().default(true),
		/** where the Metro port is leased from (`<from>[:<span>]`) */
		port: portSpec.default(DEFAULT_METRO_PORT_SPEC),
		/** extra launch arguments for the app when warden opens it on each device */
		launchArgs: z.array(z.string()).default([]),
		/** false: warden starts Metro but leaves launching the app to the specs (`app.open()`) */
		open: z.boolean().default(true),
		/** added to Metro's env only */
		env: z.record(z.string(), z.string()).optional(),
		/** build the bundle once before the first spec */
		prewarm: z.boolean().default(true),
		readyTimeout: duration.default(DEFAULT_METRO_READY_TIMEOUT),
	})
	.strict();

/** `physical` on a suite or leg: `true` = any ready physical device, `{ ids }` = exactly these (adb serials / CoreDevice UDIDs). Never booted, created or arranged. */
export const physicalSchema = z.union([z.literal(true), z.object({ ids: z.array(z.string().min(1)).min(1) }).strict()]);

/** `e2e.<suite>.devices[]`: one leg of the run, with its own device pool. */
export const e2eDeviceLegSchema = z
	.object({
		profile: z.string().min(1),
		count: z.number().int().min(1).default(1),
		/** added to this leg's setup and spec env */
		env: z.record(z.string(), z.string()).optional(),
		/** false = only with `--devices all` (or naming the profile) */
		default: z.boolean().default(true),
		/** run this leg on physical devices instead of simulators / emulators */
		physical: physicalSchema.optional(),
	})
	.strict();

const budget = z.number().nonnegative();

/** `perf` (top level, or per `e2e.<suite>`): ceilings `device.perf.stop()` holds the report to. Each is lower-is-better. */
export const perfConfigSchema = z
	.object({
		budgets: z
			.object({
				/** cold start, ms */
				startupColdMs: budget.optional(),
				/** share of janky frames, percent */
				jankPct: budget.optional(),
				/** the slowest React commit, ms */
				maxCommitMs: budget.optional(),
				/** 95th percentile app CPU, percent */
				p95CpuPct: budget.optional(),
				/** peak memory (PSS on Android, RSS on iOS), MB */
				peakMemoryMb: budget.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

/** `e2e.<suite>.spec`: how warden runs the `*.e2e.ts` specs (`bun test` + `@delacour/warden-e2e`). */
export const e2eSpecSchema = z
	.object({
		/** the app under test (default: the suite project's `bundleId` for the platform) */
		bundleId: z.string().min(1).optional(),
		/** launch arguments `app.open()` passes (after `--initialUrl` and `metro.launchArgs`) */
		launchArgs: z.array(z.string()).optional(),
		/** per-test timeout (default `2m`) */
		timeout: duration.optional(),
		/** per-action (tap / fill / waits for an element) timeout (default `30s`) */
		actionTimeout: duration.optional(),
		/** per-`expect` polling timeout (default `5s`) */
		assertionTimeout: duration.optional(),
	})
	.strict();

/** A key the suite no longer takes: any value fails with a message naming the key's path and its replacement. */
const removedKey = (key: string, hint: string) =>
	z.undefined({ error: (iss) => `e2e.${String(iss.path?.[1])}.${key} was removed: ${hint}` }).optional();

/**
 * `e2e.<suite>` in `warden.config.ts`: specs under `specsDir`, how they map to source, how to run one.
 * Paths and globs are relative to the config file's directory.
 */
export const e2eSuiteSchema = z
	.object({
		/** `projects[].name`: specs / serve / setup run in its root and `app` installs it (default: the config file's dir) */
		project: z.string().min(1).optional(),
		specsDir: path,
		/** the spec runner's settings: app under test, launch args, timeouts */
		spec: e2eSpecSchema.optional(),
		/** device (default): one `bun test` process per device runs its shard of the specs (round-robin by spec id). spec: one process per spec, one worker per device */
		isolate: z.enum(["device", "spec"]).optional(),
		/** `always`: shut down the devices warden booted once the gate passes. `idle`: leave them booted for the next run and let `warden gc` reap them when idle. Default: `always`. `--no-shutdown` wins */
		shutdown: z.enum(["always", "idle"]).optional(),
		/** per spec: a spec process still going after this long for each spec it runs is killed and counts as failed */
		jobTimeoutMs: z.number().int().min(1_000).default(DEFAULT_JOB_TIMEOUT_MS),
		/** device legs, each with its own pool, run concurrently (replaces `profile` / `count`) */
		devices: z.array(e2eDeviceLegSchema).min(1).optional(),
		/** dev-client suites: warden owns Metro for the run */
		metro: e2eMetroSchema.optional(),
		/** fallback tsconfig for files without a nearer one */
		tsconfig: path.optional(),
		/** file-based router dir (e.g. `apps/mobile/src/app`): `_layout` files above an entry are entries too */
		routerRoot: path.optional(),
		platform: platform.optional(),
		/** run the suite on physical devices (every leg without its own `physical`); needs no slim or headless */
		physical: physicalSchema.optional(),
		/** git ref changes are measured against (merge-base with HEAD) */
		base: z.string().min(1).default("main"),
		/** only import chains of at most this many hops from an entry select a spec (default: any length) */
		maxDepth: z.number().int().min(0).optional(),
		/** a change matching one of these selects every spec (lockfile, native dirs, bundler config…) */
		runAll: z.array(path).default([]),
		/** changes matching these never select anything (docs, unit tests…) */
		ignore: z.array(path).default([]),
		/** spec ids / globs that always run */
		always: z.array(path).default([]),
		/** spec-id globs: only specs matching one of these are ever selected (default: all) */
		include: z.array(path).default([]),
		/** spec-id globs that are never selected (e.g. specs another suite owns) */
		exclude: z.array(path).default([]),
		/** changed-file globs: only matching changes count at all (default: every change) */
		scope: z.array(path).default([]),
		/** a counted change that reaches no spec (no `paths` / `entries` / `runAll` match, not `ignore`d): `run-all` selects every spec, `skip` selects nothing */
		unmatched: z.enum(["run-all", "skip"]).default("skip"),
		/** a spec without entries/paths: run it every time, or only via runAll / always */
		unmapped: z.enum(["run", "skip"]).default("run"),
		/** a spec passes only after this many consecutive green runs on the same device */
		passes: z.number().int().min(1).default(1),
		retry: z.number().int().min(0).default(0),
		count: z.number().int().min(1).optional(),
		profile: z.string().min(1).optional(),
		/** install the project's app on each device first (`warden batch --app`); `{ installMode }` = `--install-mode` */
		app: appOptionSchema.optional(),
		/** ports leased for the run (`<from>[:<span>]`), exported as `WARDEN_PORT_<i>` / `WARDEN_PORTS` to serve, setup and every spec process */
		ports: z.array(portSpec).optional(),
		/** added to the serve, setup and spec env */
		env: z.record(z.string(), z.string()).optional(),
		/** `sh -c` once per run before the specs (own process group), killed at the end; `--serve` overrides */
		serve: z.string().min(1).optional(),
		/** wait for `http://…`, `tcp:PORT` or `file:PATH` before starting; `--serve-ready` overrides */
		serveReady: z.string().min(1).optional(),
		serveTimeout: duration.optional(),
		/** `sh -c` once per leased device, after the app install and before its first spec; `{udid}` is substituted. A non-zero exit drops that device from the run */
		setup: z.string().min(1).optional(),
		/** iOS: switch off the simulator daemons specs never need on each device, before `setup`. An object keeps categories (`except`, ids) or single labels (`keep`) on */
		slim: slimConfigSchema.optional(),
		/** devices of this suite have a fingerprint / Face ID enrolled (own golden, own pool); overrides the top-level `biometrics` */
		biometrics: z.boolean().optional(),
		/** removed: renamed `warmDrivers` */
		warmRunners: removedKey("warmRunners", "renamed to warmDrivers"),
		/** iOS: start every device's automation helper in parallel before the specs (default on; `false` = off) */
		warmDrivers: z.boolean().optional(),
		/** keep Simulator.app windows closed for this suite's run; `--headless` / `--no-headless` win */
		headless: z.boolean().optional(),
		/** perf budgets for this suite; each key replaces the top-level `perf.budgets` one */
		perf: perfConfigSchema.optional(),
		/** device conditions every spec of the suite starts from; each area replaces the top-level one */
		conditions: conditionsConfigSchema.optional(),
		/** default `required` for specs that don't set it */
		required: z.boolean().default(true),
		specs: z.record(z.string().min(1), e2eSpecEntrySchema).default({}),
	})
	.strict()
	.superRefine((suite, issue) => {
		if (suite.serveReady !== undefined && suite.serve === undefined)
			issue.addIssue({ code: "custom", message: "serveReady needs serve", path: ["serveReady"] });
		if (suite.serveTimeout !== undefined && suite.serve === undefined)
			issue.addIssue({ code: "custom", message: "serveTimeout needs serve", path: ["serveTimeout"] });
		if (suite.slim !== undefined && suite.slim !== false && suite.platform === "android")
			issue.addIssue({ code: "custom", message: "slim is iOS-only", path: ["slim"] });
		if (typeof suite.slim === "object") {
			const checked = validateProfile({ except: suite.slim.except ?? [], keep: suite.slim.keep ?? [] });
			if (!checked.success) issue.addIssue({ code: "custom", message: checked.error, path: ["slim"] });
		}
		for (const message of [...runIssues(suite), ...physicalIssues(suite)])
			issue.addIssue({ code: "custom", ...message });
	});

export type E2eSpecConfig = z.infer<typeof e2eSpecSchema>;
export type E2eMetroConfig = z.infer<typeof e2eMetroSchema>;
export type E2ePhysical = z.infer<typeof physicalSchema>;
export type E2eDeviceLeg = z.infer<typeof e2eDeviceLegSchema>;
export type E2eSpecEntryConfig = z.infer<typeof e2eSpecEntrySchema>;
export type E2eSlimConfig = z.infer<typeof slimConfigSchema>;
export type E2eSuiteConfig = z.infer<typeof e2eSuiteSchema>;
