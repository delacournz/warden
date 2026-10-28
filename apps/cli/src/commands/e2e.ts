import { join, resolve } from "node:path";
import type { Affected, Suite } from "@delacour/warden-core/affected/affected";
import {
	type E2eDeviceLeg,
	type E2eIsolation,
	type E2eSuiteConfig,
	suiteIsolation,
} from "@delacour/warden-core/affected/affected.schema";
import type { SelectedSpec, Selection } from "@delacour/warden-core/affected/select";
import { readySpec } from "@delacour/warden-core/batch/preset";
import { appSwitches } from "@delacour/warden-core/builds/app-option.schema";
import {
	DEFAULT_SPEC_ACTION_TIMEOUT,
	DEFAULT_SPEC_ASSERTION_TIMEOUT,
	DEFAULT_SPEC_TIMEOUT,
} from "@delacour/warden-core/config.defaults";
import { parseDuration } from "@delacour/warden-core/duration";
import { resolveHeadless } from "@delacour/warden-core/headless";
import { DEFAULT_SLIM_PROFILE, type SlimProfile, validateProfile } from "@delacour/warden-core/sims/slim.profile";
import type { Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { selfCommand } from "../autogc";
import type { DeviceSetup, DeviceSetupSpec } from "../batch/setup";
import { realPath, type TrackedSpec } from "../batch/spec-progress";
import type { WarmConnect } from "../batch/warm-drivers";
import { type ClaimFlagValues, parseClaimFlags, withClaimOptions } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { findBun, parsePerfFlag, runnerArgv, type SpecEnvOptions, specEnv } from "../e2e/bun-runner";
import { selectPreload } from "../e2e/e2e-runtime";
import { attemptOut, type JobPlan, jobPlan, type ShardRuns, shardRuns } from "../e2e/jobs";
import { type LaunchPlan, specBundleId, specLaunchArgs } from "../e2e/launch";
import { exitGate, type RunShape, type SpecVerdict, type Verdicts, verdicts } from "../e2e/verdicts";
import { type AppFlagValues, withLeaseOptions } from "../lease-session";
import { emit, note, reportError, success, warn } from "../output";
import { currentBuild } from "../update/build-info";
import { type AffectedOpts, explain, runAffected, selectedSpecs } from "./affected";
import {
	type BatchArgs,
	type BatchDeps,
	type BatchLeg,
	defaultBatchDeps,
	type MetroPlan,
	parseBatchArgs,
	runSession,
	type SessionHooks,
	type SessionResult,
	withBatchOptions,
} from "./batch";

/** Commander option values of `warden e2e`. */
export type E2eOpts = ClaimFlagValues &
	AppFlagValues &
	Omit<AffectedOpts, "json" | "strict"> & {
		json?: true;
		port: string[];
		retry: string;
		passes: string;
		serve?: string;
		serveReady?: string;
		serveTimeout: string;
		jobTimeout?: string;
		/** `--devices`: which `e2e.<suite>.devices` legs run */
		devices?: string;
		record?: string;
		logs?: string;
		tui: boolean;
		report?: string;
		dryRun?: true;
		/** false = `--no-shutdown` */
		shutdown: boolean;
		/** false = `--no-warm` (default true) */
		warm?: boolean;
		/** `--perf[=captures]`: record a perf session around every attempt */
		perf?: string | true;
	};

export type E2eReport = {
	suite: string;
	platform: Platform;
	base?: string;
	/** `device`: one spec process per device ran a shard of the specs; `spec`: one process per spec */
	isolate: E2eIsolation;
	ok: boolean;
	/** iOS: the run kept its devices' Simulator.app windows closed */
	headless: boolean;
	batchDir?: string;
	specs: SpecVerdict[];
	/** under CI: spec files with a `test.only` left in (the run fails) */
	only?: string[];
	/** per-device setup outcomes, when the suite has a `setup` */
	setup?: DeviceSetup[];
};

/** The suite's run settings as option values (CLI flags passed explicitly win). */
function suiteOpts({ config: suite, cwd, projectRoot }: Suite, opts: E2eOpts, passed: ReadonlySet<string>): E2eOpts {
	const app = appSwitches(suite.app);
	const fromSuite: Partial<E2eOpts> = {
		retry: String(suite.retry),
		passes: String(suite.passes),
		...(suite.count !== undefined ? { count: String(suite.count) } : {}),
		...(suite.profile !== undefined ? { profile: suite.profile } : {}),
		...(suite.ports ? { port: suite.ports } : {}),
		...(suite.serve !== undefined ? { serve: suite.serve } : {}),
		...(suite.serveReady !== undefined ? { serveReady: readySpec(suite.serveReady, cwd) } : {}),
		...(suite.serveTimeout !== undefined ? { serveTimeout: suite.serveTimeout } : {}),
		...(app.app ? { app: true as const, ...(projectRoot ? { project: projectRoot } : {}) } : {}),
		...(app.installMode !== undefined ? { installMode: app.installMode } : {}),
		...(app.resetKeychain ? { resetKeychain: true as const } : {}),
		...(app.variant !== undefined ? { variant: app.variant } : {}),
	};
	const cli = Object.fromEntries(Object.entries(opts).filter(([key]) => passed.has(key)));
	return { ...opts, ...fromSuite, ...cli };
}

function onePlatform(affected: Affected): Result<Selection> {
	const [only, ...rest] = affected.selections;
	if (!only || rest.length > 0)
		return err(
			`suite "${affected.suite.name}" runs on ios and android — pass --platform (or set e2e.<suite>.platform)`
		);
	return ok(only);
}

/** `slim` applies to iOS simulators only: true when the suite asks for it and this run is on iOS. */
function slimsDevices(suite: E2eSuiteConfig, platform: Platform): boolean {
	return suite.slim !== undefined && suite.slim !== false && platform === "ios";
}

/** The suite's `slim` as a profile: `true` slims every category, an object keeps its `except` / `keep` running. */
function slimProfile(slim: NonNullable<E2eSuiteConfig["slim"]>): SlimProfile {
	if (typeof slim !== "object") return DEFAULT_SLIM_PROFILE;
	return { except: slim.except ?? [], keep: slim.keep ?? [] };
}

/** The per-device prep a suite asks for (`slim` on iOS, then `setup`); undefined when there is none on this platform. */
function deviceSetup(suite: E2eSuiteConfig, platform: Platform): DeviceSetupSpec | undefined {
	const slim = slimsDevices(suite, platform);
	if (suite.setup === undefined && !slim) return undefined;
	return {
		...(suite.setup !== undefined ? { command: suite.setup } : {}),
		...(slim && suite.slim !== undefined ? { slim: slimProfile(suite.slim) } : {}),
	};
}

/** `--devices all | default | <profile,…>` → the suite's legs to run (undefined: the suite has none, or `--profile` / `--count` replace them). */
function selectLegs(
	suite: E2eSuiteConfig,
	opts: E2eOpts,
	passed: ReadonlySet<string>
): Result<E2eDeviceLeg[] | undefined> {
	const all = suite.devices;
	if (!all) return opts.devices === undefined ? ok(undefined) : err("--devices needs e2e.<suite>.devices");
	if (passed.has("profile") || passed.has("count")) return ok(undefined);
	const pick = opts.devices ?? "default";
	if (pick === "all") return ok(all);
	if (pick === "default") return ok(all.filter((leg) => leg.default));
	const names = pick
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	const unknown = names.find((name) => !all.some((leg) => leg.profile === name));
	if (unknown !== undefined || names.length === 0)
		return err(`--devices: no leg "${unknown ?? pick}" (${all.map((leg) => leg.profile).join(", ")})`);
	return ok(all.filter((leg) => names.includes(leg.profile)));
}

/** The suite's Metro as a run plan: project root, timeouts, and the app to open on each device. */
async function metroPlan(suite: Suite, bundleId: string): Promise<Result<MetroPlan | undefined>> {
	const metro = suite.config.metro;
	if (!metro?.enabled) return ok(undefined);
	const readyTimeoutMs = parseDuration(metro.readyTimeout);
	if (!readyTimeoutMs.success) return err(`metro.readyTimeout: ${readyTimeoutMs.error}`);
	return ok({
		projectRoot: suite.projectRoot ?? suite.cwd,
		env: metro.env ?? {},
		prewarm: metro.prewarm,
		readyTimeoutMs: readyTimeoutMs.data,
		launchArgs: metro.launchArgs,
		...(metro.open ? { bundleId } : {}),
	});
}

/** Write the report (batch dir + `--report`), print it for `--json`. */
async function publish(ctx: CommandContext, deps: BatchDeps, opts: E2eOpts, report: E2eReport): Promise<void> {
	const text = `${JSON.stringify(report, null, 2)}\n`;
	if (report.batchDir) await deps.writeFile(join(report.batchDir, "e2e-report.json"), text);
	if (opts.report) await deps.writeFile(opts.report, text);
	if (opts.json) emit(ctx, true, report, "");
}

/** ` on <device> — log <path> — screenshot <path>` for a spec that ran and failed (empty otherwise). */
function failureDetail(spec: SpecVerdict): string {
	const parts = [
		spec.device ? `on ${spec.device.name} (${spec.device.udid})` : undefined,
		spec.log ? `log ${spec.log}` : undefined,
		spec.screenshot ? `screenshot ${spec.screenshot}` : undefined,
	].filter((part) => part !== undefined);
	return parts.length > 0 ? ` ${parts.join(" — ")}` : "";
}

/** `  ✗ <describe › title> — <first line of the error> — artifacts <dir>` for each test that failed. */
function failedTests(spec: SpecVerdict): string[] {
	return (spec.tests ?? [])
		.filter((t) => t.status === "failed" || t.status === "timed-out")
		.map((t) => {
			const error =
				t.kind === "perf_budget"
					? t.error
							?.split("\n")
							.map((line) => line.trim())
							.join("; ")
					: t.error?.split("\n")[0];
			const parts = [
				t.title.join(" › "),
				error,
				t.artifacts ? `artifacts ${t.artifacts}` : undefined,
				t.perf ? `perf ${t.perf}` : undefined,
			].filter((part) => part !== undefined && part !== "");
			return `  ✗ ${parts.join(" — ")}`;
		});
}

/** Failed / not-run specs with their failing tests, any `test.only`, then the one-line gate verdict. */
function printVerdict(ctx: CommandContext, report: E2eReport): void {
	const { color } = ctx.ui;
	for (const spec of report.specs.filter((f) => f.verdict !== "passed")) {
		const tag = spec.required ? color.red(spec.verdict) : color.yellow(`${spec.verdict} (optional)`);
		const leg = spec.leg !== undefined ? ` [${spec.leg}]` : "";
		ctx.err(`warden e2e: ${spec.id}${leg} ${tag}${failureDetail(spec)}`);
		for (const line of failedTests(spec)) ctx.err(color.red(line));
	}
	for (const file of report.only ?? []) ctx.err(color.red(`warden e2e: test.only left in ${file}`));
	const passed = report.specs.filter((f) => f.verdict === "passed").length;
	const line = `warden e2e: ${passed}/${report.specs.length} spec(s) passed — ${report.ok ? "gate passed" : "gate failed"}`;
	if (report.ok) success(ctx, line);
	else reportError(ctx, "e2e", line.replace(/^warden e2e: /, ""));
}

/** `CI` is set to something other than empty / `0` / `false`. */
const inCi = (env: Record<string, string | undefined>): boolean => !["", "0", "false", undefined].includes(env.CI);

/**
 * Whether a passed gate shuts the devices warden booted down (closing their windows) before their
 * leases are released: the suite's `shutdown`, else yes, locally and under CI. `shutdown: "idle"`
 * keeps them booted for the next run (`warden gc` reaps them once idle). `--no-shutdown` always wins.
 */
function shutsDownOnPass(suite: Suite, opts: E2eOpts): boolean {
	if (!opts.shutdown) return false;
	return (suite.config.shutdown ?? "always") === "always";
}

/** `--headless` / `--no-headless` > the suite's (else top-level) `headless` > `WARDEN_HEADLESS`. */
function suiteHeadless(ctx: CommandContext, suite: Suite, opts: E2eOpts, passed: ReadonlySet<string>): boolean {
	return resolveHeadless({
		flag: passed.has("headless") ? opts.headless : undefined,
		config: suite.headless,
		env: ctx.env,
	});
}

type Plan = { affected: Affected; selection: Selection; specs: SelectedSpec[] };

/** Affected specs for the one platform this run is for (warnings printed, `--explain` shown). */
async function plan(ctx: CommandContext, suiteName: string | undefined, opts: E2eOpts): Promise<Result<Plan>> {
	const { color } = ctx.ui;
	const affected = await runAffected(ctx, suiteName, opts);
	if (!affected.success) return affected;
	const selection = onePlatform(affected.data);
	if (!selection.success) return selection;
	for (const w of [...affected.data.warnings, ...selection.data.warnings]) warn(ctx, `warden e2e: ${w}`);
	if (opts.explain || opts.dryRun) ctx.err(explain(affected.data, opts.requiredOnly === true, color));
	const specs = selectedSpecs(selection.data, opts.requiredOnly === true);
	if (opts.specs !== undefined && specs.length === 0) return err("--specs matched no spec");
	return ok({ affected: affected.data, selection: selection.data, specs });
}

/**
 * `warden e2e [suite]`: the specs the change needs (see `warden affected`), run on leased devices
 * like `warden batch`, each `passes` times. Once the gate passes, the devices warden created (or
 * booted) are shut down before their leases are released (`shutdown: "idle"` keeps them booted for
 * the next run), and a failed run always leaves them up. Exit 0 when every
 * required spec passed (optional failures are reported, not fatal), 1 otherwise, 130 when interrupted.
 */
async function e2e(
	ctx: CommandContext,
	deps: BatchDeps,
	suiteName: string | undefined,
	opts: E2eOpts,
	passed: ReadonlySet<string>
): Promise<number> {
	const fail = (message: string) => {
		reportError(ctx, "e2e", message);
		return 1;
	};
	const planned = await plan(ctx, suiteName, opts);
	if (!planned.success) return fail(planned.error);
	const { affected, selection, specs } = planned.data;
	const { suite } = affected;
	const headless = suiteHeadless(ctx, suite, opts, passed);
	const base = {
		suite: suite.name,
		platform: selection.platform,
		...(affected.base !== undefined ? { base: affected.base } : {}),
	};
	if (specs.length === 0 || opts.dryRun) {
		if (specs.length === 0) success(ctx, "warden e2e: no affected specs — nothing to run");
		const notRun = specs.map((f): SpecVerdict => ({ ...f, verdict: "not-run", attempts: 0 }));
		await publish(ctx, deps, opts, {
			...base,
			isolate: runIsolation(suite.config, opts, passed),
			ok: true,
			headless,
			specs: notRun,
		});
		return 0;
	}
	const run = await preparedRun(ctx, deps, suite, selection.platform, specs, { ...opts, headless }, passed);
	if (!run.success) return fail(run.error);
	const { args, shape, plan: jobs, argvOf, spec } = run.data;
	const runs = shardRuns(jobs, { argvOf, readFile: deps.readFile });
	const session = await runSession(
		ctx,
		deps,
		args,
		jobs.jobs,
		jobs.argvs.get(jobs.jobs[0] ?? "") ?? [],
		sessionHooks(suite, specs, shape, spec, runs, {
			platform: selection.platform,
			shutdown: shutsDownOnPass(suite, opts),
			...warmHooks(ctx, deps, suite, opts),
		})
	);
	const result = await verdicts(specs, session, shape, {
		readFile: deps.readFile,
		ci: inCi(ctx.env),
		attempts: runs.attempts,
	});
	for (const warning of result.warnings) ctx.err(ctx.ui.color.yellow(`warden e2e: ${warning}`));
	const report = buildReport(base, headless, shape.shardOf === undefined ? "spec" : "device", session, result);
	await publish(ctx, deps, opts, report);
	if (session.code === 130) return 130;
	printVerdict(ctx, report);
	return result.ok ? 0 : 1;
}

/** `e2e-report.json` from the session and its verdicts. */
function buildReport(
	base: Pick<E2eReport, "suite" | "platform" | "base">,
	headless: boolean,
	isolate: E2eIsolation,
	session: SessionResult,
	result: Verdicts
): E2eReport {
	return {
		...base,
		isolate,
		ok: result.ok,
		headless,
		...(session.batchDir ? { batchDir: session.batchDir } : {}),
		specs: result.specs,
		...(result.only.length > 0 ? { only: result.only } : {}),
		...(session.setups ? { setup: session.setups } : {}),
	};
}

/** Everything that can be refused before a device is leased: the spec runner and the run's flags (suite settings the platform can't honour are skipped with a note). */
async function preparedRun(
	ctx: CommandContext,
	deps: BatchDeps,
	suite: Suite,
	platform: Platform,
	specs: readonly SelectedSpec[],
	opts: E2eOpts,
	passed: ReadonlySet<string>
): AsyncResult<RunPlan & { spec: SpecPlan }> {
	if (suite.config.slim && platform !== "ios") note(ctx, `warden e2e: slim is iOS-only; skipped on ${platform}`);
	if (slimsDevices(suite.config, platform) && suite.config.slim !== undefined) {
		const slim = validateProfile(slimProfile(suite.config.slim));
		if (!slim.success) return err(`suite "${suite.name}": slim: ${slim.error}`);
	}
	const spec = await specPlan(ctx, deps, suite, platform, opts);
	if (!spec.success) return spec;
	const run = await runPlan(ctx, suite, platform, specs, spec.data, opts, passed);
	return run.success ? ok({ ...run.data, spec: spec.data }) : run;
}

/**
 * The socket-helper warm-up: on unless the suite sets `warmDrivers: false` or `--no-warm` is passed. Without
 * it, a helper that is already running for a device still serves that device's jobs (`resident`).
 */
function warmHooks(
	ctx: CommandContext,
	deps: BatchDeps,
	suite: Suite,
	opts: E2eOpts
): { warm: WarmConnect | undefined; resident: ((udid: string) => Promise<string | undefined>) | undefined } {
	if (suite.config.warmDrivers === false || opts.warm === false) {
		return { warm: undefined, resident: deps.residentSocket?.(ctx) };
	}
	return { warm: deps.warmConnect(ctx), resident: undefined };
}

/** How the batch session runs the suite: per-device setup, spec argv + env per job, live specs (device isolation) and the shutdown rule. */
function sessionHooks(
	suite: Suite,
	specs: readonly SelectedSpec[],
	shape: RunShape,
	spec: SpecPlan,
	runs: ShardRuns,
	o: {
		platform: Platform;
		shutdown: boolean;
		warm: WarmConnect | undefined;
		resident: ((udid: string) => Promise<string | undefined>) | undefined;
	}
): SessionHooks {
	return {
		name: "e2e",
		setup: deviceSetup(suite.config, o.platform),
		// batch skips both off iOS
		warmDrivers: o.warm,
		residentSocket: o.resident,
		specs: trackedSpecs(specs, shape),
		// a passed gate frees the sims when asked to; a failed one always leaves them up to inspect
		...(o.shutdown ? { shutdownIf: (summary) => exitGate(specs, summary, shape) } : {}),
		argvFor: (_job, run) => runs.argv(run),
		jobEnv: (job) =>
			specEnv({
				...spec.env,
				launchArgs: specLaunchArgs(spec.launch, job.metroUrl),
				out: attemptOut(job.batchDir, job.worker, job.seq, job.pass),
			}),
	};
}

/** The specs whose `results.jsonl` tests are followed live: their spec files, and the shard job that runs them under device isolation. */
function trackedSpecs(specs: readonly SelectedSpec[], shape: RunShape): TrackedSpec[] {
	return specs.map((f) => {
		const job = shape.shardOf?.get(f.id);
		return { id: f.id, path: realPath(f.file), ...(job !== undefined ? { job } : {}) };
	});
}

/**
 * The suite + CLI flags as a batch run: claim flags (one per device leg), Metro, the job timeout, and
 * how its jobs map back to specs. With Metro its port is leased first, so it is `{port}` / `WARDEN_PORT`.
 */
async function runPlan(
	ctx: CommandContext,
	suite: Suite,
	platform: Platform,
	specs: readonly SelectedSpec[],
	spec: SpecPlan,
	opts: E2eOpts,
	passed: ReadonlySet<string>
): AsyncResult<RunPlan> {
	const { config } = suite;
	const picked = selectLegs(config, opts, passed);
	if (!picked.success) return picked;
	const metro = await metroPlan(suite, spec.env.bundleId);
	if (!metro.success) return metro;
	// --json is the e2e report here, not batch.json
	const { json: _json, ...merged } = suiteOpts(suite, opts, passed);
	const needsApp = appFlagsWithoutApp(suite, merged);
	if (needsApp !== undefined) return err(needsApp);
	const batchOpts = { ...merged, ...(config.metro?.enabled ? { port: [config.metro.port, ...merged.port] } : {}) };
	const slimFlag = passed.has("slim") ? opts.slim : undefined;
	const legOpts = (leg: E2eDeviceLeg) => ({
		...batchOpts,
		profile: leg.profile,
		count: String(leg.count),
		slim: slimFlag,
		...(suite.slim !== undefined ? { slimConfig: suite.slim } : {}),
	});
	const [first] = picked.data ?? [];
	const args = parseBatchArgs(platform, first ? legOpts(first) : batchOpts, ctx.cwd, {
		jobs: { kind: "list", jobs: specs.map((f) => f.id) },
		cwd: suite.cwd,
		env: { ...config.env },
	});
	if (!args.success) return args;
	const legs = batchLegs(platform, picked.data ?? [], legOpts);
	if (!legs.success) return legs;
	const argvOf = (files: readonly string[]) =>
		runnerArgv({ bun: spec.bun, preload: spec.preload, specPaths: files, timeoutMs: spec.env.timeouts.timeoutMs });
	const isolation = runIsolation(config, opts, passed);
	if (isolation === "device" && args.data.passes > 1)
		return err(
			`--passes ${args.data.passes} needs isolate "spec": suite "${suite.name}" sets isolate "device" (one process per device reruns its whole shard)`
		);
	const plan = jobPlan(specs, isolation === "device" ? shardCount(args.data, legs.data) : undefined, argvOf);
	const planned = planOf(
		{ ...args.data, jobs: { kind: "list", jobs: plan.jobs } },
		legs.data,
		config,
		metro.data,
		biggestShard(plan)
	);
	return ok({
		args: planned.args,
		shape: { ...planned.shape, ...(plan.shardOf ? { shardOf: plan.shardOf } : {}) },
		plan,
		argvOf,
	});
}

/**
 * The install flags (`--install-mode`, `--reset-keychain`, `--clean`) act on the installed app, so they need the
 * suite to install one: `app` in the suite config or `--app` on the command line. Refused up front, naming the suite.
 */
function appFlagsWithoutApp(suite: Suite, opts: E2eOpts): string | undefined {
	if (opts.app) return undefined;
	const flags = [
		opts.installMode !== undefined ? "--install-mode" : undefined,
		opts.resetKeychain ? "--reset-keychain" : undefined,
		opts.clean ? "--clean" : undefined,
	].filter((flag) => flag !== undefined);
	if (flags.length === 0) return undefined;
	return `${flags.join(" / ")} need an app to install, but suite "${suite.name}" has no \`app\` — set e2e.${suite.name}.app or pass --app`;
}

/** The run's isolation from the suite and the `passes` it runs with: a CLI `--passes` counts too (12-10). */
function runIsolation(config: E2eSuiteConfig, opts: E2eOpts, passed: ReadonlySet<string>): E2eIsolation {
	const passes = passed.has("passes") && /^\d+$/.test(opts.passes) ? Number(opts.passes) : config.passes;
	return suiteIsolation({ ...config, passes });
}

/** Specs in the biggest shard (1 when every spec is its own job). */
function biggestShard(plan: JobPlan): number {
	return Math.max(1, ...[...(plan.shards?.values() ?? [])].map((specs) => specs.length));
}

/** Devices the run asks for: the biggest leg's, or the plain claim's. */
function shardCount(args: BatchArgs, legs: readonly BatchLeg[]): number {
	return Math.max(args.flags.request.count, ...legs.map((leg) => leg.flags.request.count));
}

/** Everything `runSession` needs: the batch run, how its jobs map to specs, and each job's argv. */
type RunPlan = {
	args: BatchArgs;
	shape: RunShape;
	plan: JobPlan;
	/** the `bun test` argv over some spec files */
	argvOf: (files: readonly string[]) => string[];
};

/** The spec runner, resolved before any device is leased: `bun`, the preload, the app and the spec env. */
export type SpecPlan = {
	bun: string;
	preload: string;
	launch: LaunchPlan;
	env: Omit<SpecEnvOptions, "launchArgs" | "out">;
};

const specDuration = (field: string, value: string | undefined, fallback: string): Result<number> => {
	const ms = parseDuration(value ?? fallback);
	return ms.success ? ms : err(`e2e.spec.${field}: ${ms.error}`);
};

/** What `specPlan` needs of `BatchDeps` (`warden ui record stop` resolves the same plan to verify a spec). */
export type SpecPlanDeps = Pick<BatchDeps, "execPath" | "resolveModule" | "e2eVersion" | "bundledE2e" | "helperDir">;

/** `bun` + preload + bundle id + timeouts of the suite's specs; every failure names what to set or install. */
export async function specPlan(
	ctx: CommandContext,
	deps: SpecPlanDeps,
	suite: Suite,
	platform: Platform,
	opts: Pick<E2eOpts, "perf"> = {}
): AsyncResult<SpecPlan> {
	const bun = findBun(ctx.env, deps.execPath());
	const version = currentBuild().version;
	const preload = await selectPreload({
		cwd: suite.cwd,
		version,
		resolve: deps.resolveModule,
		readVersion: deps.e2eVersion,
		stage: () => deps.bundledE2e(ctx),
	});
	if (!preload.success) return preload;
	const bundleId = await specBundleId(ctx, suite, platform);
	if (!bundleId.success) return bundleId;
	const perf = parsePerfFlag(opts.perf);
	if (!perf.success) return perf;
	const { spec } = suite.config;
	const timeoutMs = specDuration("timeout", spec?.timeout, DEFAULT_SPEC_TIMEOUT);
	if (!timeoutMs.success) return timeoutMs;
	const actionTimeoutMs = specDuration("actionTimeout", spec?.actionTimeout, DEFAULT_SPEC_ACTION_TIMEOUT);
	if (!actionTimeoutMs.success) return actionTimeoutMs;
	const assertionTimeoutMs = specDuration("assertionTimeout", spec?.assertionTimeout, DEFAULT_SPEC_ASSERTION_TIMEOUT);
	if (!assertionTimeoutMs.success) return assertionTimeoutMs;
	return ok({
		bun,
		preload: preload.data.path,
		launch: {
			metroLaunchArgs: suite.config.metro?.enabled ? suite.config.metro.launchArgs : [],
			launchArgs: spec?.launchArgs ?? [],
		},
		env: {
			platform,
			bundleId: bundleId.data,
			timeouts: {
				timeoutMs: timeoutMs.data,
				actionTimeoutMs: actionTimeoutMs.data,
				assertionTimeoutMs: assertionTimeoutMs.data,
			},
			specsDir: resolve(suite.configDir, suite.config.specsDir),
			helperDir: ctx.env.WARDEN_HELPER_DIR ?? deps.helperDir(),
			version,
			bin: selfCommand(),
			...(perf.data === undefined ? {} : { perf: perf.data }),
			...(suite.perfBudgets === undefined ? {} : { perfBudgets: suite.perfBudgets }),
		},
	});
}

/** One claim per picked device leg. */
function batchLegs(
	platform: Platform,
	picked: readonly E2eDeviceLeg[],
	legOpts: (leg: E2eDeviceLeg) => ClaimFlagValues
): Result<BatchLeg[]> {
	const legs: BatchLeg[] = [];
	for (const leg of picked) {
		const flags = parseClaimFlags(platform, legOpts(leg));
		if (!flags.success) return flags;
		legs.push({ name: leg.profile, flags: flags.data, env: leg.env ?? {} });
	}
	return ok(legs);
}

/** `specsPerJob` specs share one spec process, and the job timeout (`jobTimeoutMs`, `--job-timeout`) is per spec. */
function planOf(
	args: BatchArgs,
	legs: BatchLeg[],
	config: E2eSuiteConfig,
	metro: MetroPlan | undefined,
	specsPerJob: number
): { args: BatchArgs; shape: RunShape } {
	return {
		args: {
			...args,
			jobTimeoutMs: (args.jobTimeoutMs ?? config.jobTimeoutMs) * specsPerJob,
			...(legs.length > 0 ? { legs } : {}),
			...(metro ? { metro } : {}),
		},
		shape: { legs: legs.length > 0 ? legs.map((leg) => leg.name) : [undefined] },
	};
}

/**
 * `warden e2e [suite] [--base ref] [--platform p] [claim / batch options]`: select → lease → run → gate.
 */
export function createE2eCommand(deps: BatchDeps): Command {
	return defineCommand({
		name: "e2e",
		group: "Run",
		summary: "run the e2e specs a change needs on leased devices; exit 1 if a required spec fails",
		register: (cmd, ctx, done) => {
			withBatchOptions(
				withLeaseOptions(
					withClaimOptions(cmd.argument("[suite]", "e2e.<suite> in warden.config.ts (optional with one suite)"))
				)
			)
				.option("--base <ref>", "compare against merge-base with this ref (default: the suite's base)")
				.option("--platform <platform>", "ios | android (default: the suite's platform)")
				.option("--files <list>", "comma-separated changed files (relative to cwd) instead of git")
				.option("--all", "run every spec of the suite (after include / exclude), skipping the git diff")
				.option("--specs <list>", "run exactly these spec ids / globs (comma-separated), skipping the git diff")
				.option("--required-only", "only run specs with required: true")
				.option("--explain", "print why each spec was selected before running")
				.option("--dry-run", "select and explain, run nothing")
				.option("--report <file>", "also write e2e-report.json here")
				.option("--devices <legs>", "which e2e.<suite>.devices legs run: default | all | <profile,…>")
				.option(
					"--no-shutdown",
					"keep the devices running after the gate passes (default: shut down the ones warden created; suite shutdown)"
				)
				.option(
					"--perf [captures]",
					"profile every attempt (bare: metrics, frames, logs; or --perf=react,js | all); reports land in the attempt's perf/ dir"
				)
				.option("--no-warm", "skip pre-warming the iOS socket helper per device (default: on; suite warmDrivers)")
				.addHelpText(
					"after",
					"\nExamples:\n  warden e2e mobile --base origin/main --count 2\n  warden e2e --dry-run --files src/modules/chat/api.ts"
				)
				.action(async (suite, opts, command) => {
					const passed = new Set(Object.keys(opts).filter((key) => command.getOptionValueSource(key) === "cli"));
					done(await e2e(ctx, deps, suite, opts, passed));
				});
		},
	});
}

export const e2eCommand: Command = createE2eCommand(defaultBatchDeps);
