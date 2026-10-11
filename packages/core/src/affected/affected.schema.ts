import { z } from "zod";
import { duration, portSpec } from "../batch/preset.schema";
import { appOptionSchema } from "../builds/app-option.schema";
import { DEFAULT_JOB_TIMEOUT_MS, DEFAULT_METRO_PORT_SPEC, DEFAULT_METRO_READY_TIMEOUT } from "../config.defaults";

const path = z.string().min(1);
const platform = z.enum(["ios", "android"]);

/** `e2e.<suite>.flows.<id|glob>`: what a flow covers and whether it gates. */
export const e2eFlowSchema = z
	.object({
		/** files the flow drives (screens / routes); everything they import, transitively, selects the flow */
		entries: z.array(path).default([]),
		/** extra globs that select the flow when a changed file matches */
		paths: z.array(path).default([]),
		/** default: inferred from the flow id (`-ios-` / `-android-`), else both */
		platforms: z.array(platform).min(1).optional(),
		/** overrides the suite's `maxDepth` */
		maxDepth: z.number().int().min(0).optional(),
		/** a failure fails `warden e2e`; false = reported only */
		required: z.boolean().optional(),
	})
	.strict();

type RunSettings = {
	runner: string[];
	mode: "per-flow" | "single";
	passes: number;
	count?: number | undefined;
	profile?: string | undefined;
	devices?: Array<{ profile: string; default: boolean }> | undefined;
};

/** What `mode` and `devices` rule out. */
function runIssues(suite: RunSettings): Array<{ message: string; path: string[] }> {
	const issues: Array<{ message: string; path: string[] }> = [];
	const single = suite.mode === "single";
	if (single && suite.runner.some((arg) => PER_FLOW_PLACEHOLDER.test(arg)))
		issues.push({
			message: 'mode "single" runs every flow in one process: use {flows} / {flowPaths}',
			path: ["runner"],
		});
	if (!single && suite.runner.some((arg) => SINGLE_PLACEHOLDER.test(arg)))
		issues.push({ message: '{flows} / {flowPaths} need mode "single"', path: ["runner"] });
	if (single && suite.passes > 1)
		issues.push({
			message: 'passes > 1 needs mode "per-flow" (one process cannot be re-run per flow)',
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

/** `e2e.<suite>.metro`: warden starts one Metro for the run and points the dev client at it. */
export const e2eMetroSchema = z
	.object({
		enabled: z.boolean().default(true),
		/** where the Metro port is leased from (`<from>[:<span>]`) */
		port: portSpec.default(DEFAULT_METRO_PORT_SPEC),
		/** extra launch arguments for the app when warden opens it on each device */
		launchArgs: z.array(z.string()).default([]),
		/** false: warden starts Metro but leaves launching the app to the runner (it installs the app itself) */
		open: z.boolean().default(true),
		/** added to Metro's env only */
		env: z.record(z.string(), z.string()).optional(),
		/** build the bundle once before the first flow */
		prewarm: z.boolean().default(true),
		readyTimeout: duration.default(DEFAULT_METRO_READY_TIMEOUT),
	})
	.strict();

/** `e2e.<suite>.devices[]`: one leg of the run, with its own device pool. */
export const e2eDeviceLegSchema = z
	.object({
		profile: z.string().min(1),
		count: z.number().int().min(1).default(1),
		/** added to this leg's setup and runner env */
		env: z.record(z.string(), z.string()).optional(),
		/** false = only with `--devices all` (or naming the profile) */
		default: z.boolean().default(true),
	})
	.strict();

const PER_FLOW_PLACEHOLDER = /\{(flow|flowPath)\}/;
const SINGLE_PLACEHOLDER = /\{(flows|flowPaths)\}/;

/**
 * `e2e.<suite>` in `warden.config.ts`: flows under `flowsDir`, how they map to source, how to run one.
 * Paths and globs are relative to the config file's directory.
 */
export const e2eSuiteSchema = z
	.object({
		/** `projects[].name`: runner / serve / setup run in its root and `app` installs it (default: the config file's dir) */
		project: z.string().min(1).optional(),
		flowsDir: path,
		/**
		 * runner argv. `{udid}` `{worker}` `{seq}` `{port}` `{metroUrl}` `{stateDir}` `{leg}` are substituted; per flow also
		 * `{flow}` `{flowPath}`, in `mode: "single"` an argument that is exactly `{flows}` / `{flowPaths}` becomes one argument per flow
		 */
		runner: z.array(z.string()).min(1),
		/** per-flow: one runner process per flow, one worker per device. single: one runner process per leg for every selected flow; it shards over `WARDEN_UDIDS` itself */
		mode: z.enum(["per-flow", "single"]).default("per-flow"),
		/** a runner process still going after this long is killed and counts as failed */
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
		/** git ref changes are measured against (merge-base with HEAD) */
		base: z.string().min(1).default("main"),
		/** only import chains of at most this many hops from an entry select a flow (default: any length) */
		maxDepth: z.number().int().min(0).optional(),
		/** a change matching one of these selects every flow (lockfile, native dirs, bundler config…) */
		runAll: z.array(path).default([]),
		/** changes matching these never select anything (docs, unit tests…) */
		ignore: z.array(path).default([]),
		/** flow ids / globs that always run */
		always: z.array(path).default([]),
		/** flow-id globs: only flows matching one of these are ever selected (default: all) */
		include: z.array(path).default([]),
		/** flow-id globs that are never selected (e.g. flows another suite owns) */
		exclude: z.array(path).default([]),
		/** changed-file globs: only matching changes count at all (default: every change) */
		scope: z.array(path).default([]),
		/** a counted change that reaches no flow (no `paths` / `entries` / `runAll` match, not `ignore`d): `run-all` selects every flow, `skip` selects nothing */
		unmatched: z.enum(["run-all", "skip"]).default("skip"),
		/** a flow without entries/paths: run it every time, or only via runAll / always */
		unmapped: z.enum(["run", "skip"]).default("run"),
		/** a flow passes only after this many consecutive green runs on the same device */
		passes: z.number().int().min(1).default(1),
		retry: z.number().int().min(0).default(0),
		count: z.number().int().min(1).optional(),
		profile: z.string().min(1).optional(),
		/** install the project's app on each device first (`warden batch --app`); `{ clean: true }` = `--clean` */
		app: appOptionSchema.optional(),
		/** ports leased for the run (`<from>[:<span>]`), exported as `WARDEN_PORT_<i>` / `WARDEN_PORTS` to serve, setup and every runner */
		ports: z.array(portSpec).optional(),
		/** added to the serve, setup and runner env */
		env: z.record(z.string(), z.string()).optional(),
		/** `sh -c` once per run before the flows (own process group), killed at the end; `--serve` overrides */
		serve: z.string().min(1).optional(),
		/** wait for `http://…`, `tcp:PORT` or `file:PATH` before starting; `--serve-ready` overrides */
		serveReady: z.string().min(1).optional(),
		serveTimeout: duration.optional(),
		/** `sh -c` once per leased device, after the app install and before its first flow; `{udid}` is substituted. A non-zero exit drops that device from the run */
		setup: z.string().min(1).optional(),
		/** iOS: switch off the simulator daemons flows never need on each device, before `setup` */
		slim: z.boolean().optional(),
		/** default `required` for flows that don't set it */
		required: z.boolean().default(true),
		flows: z.record(z.string().min(1), e2eFlowSchema).default({}),
	})
	.strict()
	.superRefine((suite, issue) => {
		if (suite.serveReady !== undefined && suite.serve === undefined)
			issue.addIssue({ code: "custom", message: "serveReady needs serve", path: ["serveReady"] });
		if (suite.serveTimeout !== undefined && suite.serve === undefined)
			issue.addIssue({ code: "custom", message: "serveTimeout needs serve", path: ["serveTimeout"] });
		if (suite.slim === true && suite.platform === "android")
			issue.addIssue({ code: "custom", message: "slim is iOS-only", path: ["slim"] });
		for (const message of runIssues(suite)) issue.addIssue({ code: "custom", ...message });
	});

export type E2eMetroConfig = z.infer<typeof e2eMetroSchema>;
export type E2eDeviceLeg = z.infer<typeof e2eDeviceLegSchema>;
export type E2eFlowConfig = z.infer<typeof e2eFlowSchema>;
export type E2eSuiteConfig = z.infer<typeof e2eSuiteSchema>;
