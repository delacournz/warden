import { join, resolve } from "node:path";
import type { Affected, Suite } from "@delacour/warden-core/affected/affected";
import type { E2eDeviceLeg, E2eSuiteConfig } from "@delacour/warden-core/affected/affected.schema";
import type { SelectedFlow, Selection } from "@delacour/warden-core/affected/select";
import { readySpec } from "@delacour/warden-core/batch/preset";
import { appSwitches } from "@delacour/warden-core/builds/app-option.schema";
import {
	DEFAULT_SPEC_ACTION_TIMEOUT,
	DEFAULT_SPEC_ASSERTION_TIMEOUT,
	DEFAULT_SPEC_TIMEOUT,
} from "@delacour/warden-core/config.defaults";
import { parseDuration } from "@delacour/warden-core/duration";
import { resolveHeadless } from "@delacour/warden-core/headless";
import type { Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { realPath, type TrackedFlow } from "../batch/flow-progress";
import type { DeviceSetup, DeviceSetupSpec } from "../batch/setup";
import { type ClaimFlagValues, parseClaimFlags, withClaimOptions } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { findBun, findPreload, runnerArgv, type SpecEnvOptions, shardFlows, specEnv } from "../e2e/bun-runner";
import { type LaunchPlan, specBundleId, specLaunchArgs } from "../e2e/launch";
import { exitGate, type FlowVerdict, type RunShape, type Verdicts, verdicts } from "../e2e/verdicts";
import { type AppFlagValues, withLeaseOptions } from "../lease-session";
import { emit } from "../output";
import { type AffectedOpts, explain, runAffected, selectedFlows } from "./affected";
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
	};

export type E2eReport = {
	suite: string;
	platform: Platform;
	base?: string;
	/** `single`: one spec process per device ran a shard of the flows, so a shard's flows share its process's verdict */
	mode?: "single";
	ok: boolean;
	/** iOS: the run kept its devices' Simulator.app windows closed */
	headless: boolean;
	batchDir?: string;
	flows: FlowVerdict[];
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

/** Suite settings the platform can't honour (undefined = fine). */
function platformError(suite: E2eSuiteConfig, platform: Platform): string | undefined {
	return suite.slim && platform !== "ios" ? "slim is iOS-only" : undefined;
}

/** The per-device prep a suite asks for (`slim`, then `setup`). */
function deviceSetup(suite: E2eSuiteConfig): DeviceSetupSpec | undefined {
	if (suite.setup === undefined && !suite.slim) return undefined;
	return {
		...(suite.setup !== undefined ? { command: suite.setup } : {}),
		...(suite.slim ? { slim: true } : {}),
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

/** ` on <device> — log <path> — screenshot <path>` for a flow that ran and failed (empty otherwise). */
function failureDetail(flow: FlowVerdict): string {
	const parts = [
		flow.device ? `on ${flow.device.name} (${flow.device.udid})` : undefined,
		flow.log ? `log ${flow.log}` : undefined,
		flow.screenshot ? `screenshot ${flow.screenshot}` : undefined,
	].filter((part) => part !== undefined);
	return parts.length > 0 ? ` ${parts.join(" — ")}` : "";
}

/** `  ✗ <describe › title> — <first line of the error> — artifacts <dir>` for each test that failed. */
function failedTests(flow: FlowVerdict): string[] {
	return (flow.tests ?? [])
		.filter((t) => t.status === "failed" || t.status === "timed-out")
		.map((t) => {
			const error = t.error?.split("\n")[0];
			const parts = [t.title.join(" › "), error, t.artifacts ? `artifacts ${t.artifacts}` : undefined].filter(
				(part) => part !== undefined && part !== ""
			);
			return `  ✗ ${parts.join(" — ")}`;
		});
}

/** Failed / not-run flows with their failing tests, any `test.only`, then the one-line gate verdict. */
function printVerdict(ctx: CommandContext, report: E2eReport): void {
	const { color } = ctx.ui;
	for (const flow of report.flows.filter((f) => f.verdict !== "passed")) {
		const tag = flow.required ? color.red(flow.verdict) : color.yellow(`${flow.verdict} (optional)`);
		const leg = flow.leg !== undefined ? ` [${flow.leg}]` : "";
		ctx.err(`warden e2e: ${flow.id}${leg} ${tag}${failureDetail(flow)}`);
		for (const line of failedTests(flow)) ctx.err(color.red(line));
	}
	for (const file of report.only ?? []) ctx.err(color.red(`warden e2e: test.only left in ${file}`));
	const passed = report.flows.filter((f) => f.verdict === "passed").length;
	const line = `warden e2e: ${passed}/${report.flows.length} flow(s) passed — ${report.ok ? "gate passed" : "gate failed"}`;
	ctx.err((report.ok ? color.green : color.red)(line));
}

/** `CI` is set to something other than empty / `0` / `false`. */
const inCi = (env: Record<string, string | undefined>): boolean => !["", "0", "false", undefined].includes(env.CI);

/** `--headless` / `--no-headless` > the suite's (else top-level) `headless` > `WARDEN_HEADLESS`. */
function suiteHeadless(ctx: CommandContext, suite: Suite, opts: E2eOpts, passed: ReadonlySet<string>): boolean {
	return resolveHeadless({
		flag: passed.has("headless") ? opts.headless : undefined,
		config: suite.headless,
		env: ctx.env,
	});
}

type Plan = { affected: Affected; selection: Selection; flows: SelectedFlow[] };

/** Affected flows for the one platform this run is for (warnings printed, `--explain` shown). */
async function plan(ctx: CommandContext, suiteName: string | undefined, opts: E2eOpts): Promise<Result<Plan>> {
	const { color } = ctx.ui;
	const affected = await runAffected(ctx, suiteName, opts);
	if (!affected.success) return affected;
	const selection = onePlatform(affected.data);
	if (!selection.success) return selection;
	for (const w of [...affected.data.warnings, ...selection.data.warnings]) ctx.err(color.yellow(`warden e2e: ${w}`));
	if (opts.explain || opts.dryRun) ctx.err(explain(affected.data, opts.requiredOnly === true, color));
	const flows = selectedFlows(selection.data, opts.requiredOnly === true);
	if (opts.flows !== undefined && flows.length === 0) return err("--flows matched no flow");
	return ok({ affected: affected.data, selection: selection.data, flows });
}

/**
 * `warden e2e [suite]`: the flows the change needs (see `warden affected`), run on leased devices
 * like `warden batch`, each `passes` times. Once the gate passes, the devices warden created (or
 * booted) are shut down before their leases are released; a failed run leaves them up. Exit 0 when every required flow passed (optional
 * failures are reported, not fatal), 1 otherwise, 130 when interrupted.
 */
async function e2e(
	ctx: CommandContext,
	deps: BatchDeps,
	suiteName: string | undefined,
	opts: E2eOpts,
	passed: ReadonlySet<string>
): Promise<number> {
	const fail = (message: string) => {
		ctx.err(ctx.ui.color.red(`warden e2e: ${message}`));
		return 1;
	};
	const planned = await plan(ctx, suiteName, opts);
	if (!planned.success) return fail(planned.error);
	const { affected, selection, flows } = planned.data;
	const { suite } = affected;
	const headless = suiteHeadless(ctx, suite, opts, passed);
	const base = {
		suite: suite.name,
		platform: selection.platform,
		...(affected.base !== undefined ? { base: affected.base } : {}),
	};
	if (flows.length === 0 || opts.dryRun) {
		if (flows.length === 0) ctx.err(ctx.ui.color.green("warden e2e: no affected flows — nothing to run"));
		const notRun = flows.map((f): FlowVerdict => ({ ...f, verdict: "not-run", attempts: 0 }));
		await publish(ctx, deps, opts, { ...base, ok: true, headless, flows: notRun });
		return 0;
	}
	const run = await preparedRun(ctx, deps, suite, selection.platform, flows, { ...opts, headless }, passed);
	if (!run.success) return fail(run.error);
	const { args, shape, jobs, argvs, spec } = run.data;
	const single = shape.shardOf !== undefined;
	const session = await runSession(
		ctx,
		deps,
		args,
		jobs,
		argvs.get(jobs[0] ?? "") ?? [],
		sessionHooks(suite, flows, shape, spec, argvs, opts.shutdown)
	);
	const result = await verdicts(flows, session, shape, { readFile: deps.readFile, ci: inCi(ctx.env) });
	for (const warning of result.warnings) ctx.err(ctx.ui.color.yellow(`warden e2e: ${warning}`));
	const report = buildReport(base, headless, single, session, result);
	await publish(ctx, deps, opts, report);
	if (session.code === 130) return 130;
	printVerdict(ctx, report);
	return result.ok ? 0 : 1;
}

/** `e2e-report.json` from the session and its verdicts. */
function buildReport(
	base: Pick<E2eReport, "suite" | "platform" | "base">,
	headless: boolean,
	single: boolean,
	session: SessionResult,
	result: Verdicts
): E2eReport {
	return {
		...base,
		...(single ? { mode: "single" as const } : {}),
		ok: result.ok,
		headless,
		...(session.batchDir ? { batchDir: session.batchDir } : {}),
		flows: result.flows,
		...(result.only.length > 0 ? { only: result.only } : {}),
		...(session.setups ? { setup: session.setups } : {}),
	};
}

/** Everything that can be refused before a device is leased: the platform, the spec runner, the run's flags. */
async function preparedRun(
	ctx: CommandContext,
	deps: BatchDeps,
	suite: Suite,
	platform: Platform,
	flows: readonly SelectedFlow[],
	opts: E2eOpts,
	passed: ReadonlySet<string>
): AsyncResult<RunPlan & { spec: SpecPlan }> {
	const unsupported = platformError(suite.config, platform);
	if (unsupported) return err(unsupported);
	const spec = await specPlan(ctx, deps, suite, platform);
	if (!spec.success) return spec;
	const run = await runPlan(ctx, suite, platform, flows, spec.data, opts, passed);
	return run.success ? ok({ ...run.data, spec: spec.data }) : run;
}

/** How the batch session runs the suite: per-device setup, spec argv + env per job, live flows (`single`) and the shutdown rule. */
function sessionHooks(
	suite: Suite,
	flows: readonly SelectedFlow[],
	shape: RunShape,
	spec: SpecPlan,
	argvs: ReadonlyMap<string, string[]>,
	shutdown: boolean
): SessionHooks {
	return {
		name: "e2e",
		setup: deviceSetup(suite.config),
		// on unless the suite opts out; batch skips it off iOS
		warmDrivers: suite.config.warmDrivers !== false,
		flows: trackedFlows(flows, shape),
		// a passed gate frees the sims; a failed one leaves them up to inspect
		...(shutdown ? { shutdownIf: (summary) => exitGate(flows, summary, shape) } : {}),
		argvFor: (job) => argvs.get(job) ?? [],
		jobEnv: (job) =>
			specEnv({
				...spec.env,
				launchArgs: specLaunchArgs(spec.launch, job.metroUrl),
				out: join(job.batchDir, "e2e", `${job.worker}-${job.seq}`),
			}),
	};
}

/** The flows whose `results.jsonl` tests are followed live: their spec files, and the shard job that runs them in `single` mode. */
function trackedFlows(flows: readonly SelectedFlow[], shape: RunShape): TrackedFlow[] {
	return flows.map((f) => {
		const job = shape.shardOf?.get(f.id);
		return { id: f.id, path: realPath(f.file), ...(job !== undefined ? { job } : {}) };
	});
}

/**
 * The suite + CLI flags as a batch run: claim flags (one per device leg), Metro, the job timeout, and
 * how its jobs map back to flows. With Metro its port is leased first, so it is `{port}` / `WARDEN_PORT`.
 */
async function runPlan(
	ctx: CommandContext,
	suite: Suite,
	platform: Platform,
	flows: readonly SelectedFlow[],
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
	const batchOpts = { ...merged, ...(config.metro?.enabled ? { port: [config.metro.port, ...merged.port] } : {}) };
	const legOpts = (leg: E2eDeviceLeg) => ({ ...batchOpts, profile: leg.profile, count: String(leg.count) });
	const [first] = picked.data ?? [];
	const args = parseBatchArgs(platform, first ? legOpts(first) : batchOpts, ctx.cwd, {
		jobs: { kind: "list", jobs: flows.map((f) => f.id) },
		cwd: suite.cwd,
		env: { ...config.env },
	});
	if (!args.success) return args;
	const legs = batchLegs(platform, picked.data ?? [], legOpts);
	if (!legs.success) return legs;
	const jobs = jobPlan(flows, config.mode === "single" ? shardCount(args.data, legs.data) : undefined, spec);
	const planned = planOf({ ...args.data, jobs: { kind: "list", jobs: jobs.jobs } }, legs.data, config, metro.data);
	return ok({
		args: planned.args,
		shape: { ...planned.shape, ...(jobs.shardOf ? { shardOf: jobs.shardOf } : {}) },
		jobs: jobs.jobs,
		argvs: jobs.argvs,
	});
}

/** Devices the run asks for: the biggest leg's, or the plain claim's. */
function shardCount(args: BatchArgs, legs: readonly BatchLeg[]): number {
	return Math.max(args.flags.request.count, ...legs.map((leg) => leg.flags.request.count));
}

/**
 * The batch jobs and the `bun test` argv of each: one per flow, or (`shards`) one `shard-<k>` per
 * device over its round-robin share of the flows.
 */
function jobPlan(
	flows: readonly SelectedFlow[],
	shards: number | undefined,
	spec: SpecPlan
): { jobs: string[]; argvs: Map<string, string[]>; shardOf?: Map<string, string> } {
	const argvOf = (files: readonly string[]) =>
		runnerArgv({ bun: spec.bun, preload: spec.preload, flowPaths: files, timeoutMs: spec.env.timeouts.timeoutMs });
	const argvs = new Map<string, string[]>();
	if (shards === undefined) {
		for (const flow of flows) argvs.set(flow.id, argvOf([flow.file]));
		return { jobs: flows.map((f) => f.id), argvs };
	}
	const shardOf = new Map<string, string>();
	shardFlows(flows, shards).forEach((share, k) => {
		const job = `shard-${k}`;
		argvs.set(job, argvOf(share.map((f) => f.file)));
		for (const flow of share) shardOf.set(flow.id, job);
	});
	return { jobs: [...argvs.keys()], argvs, shardOf };
}

/** Everything `runSession` needs: the batch run, how its jobs map to flows, and each job's argv. */
type RunPlan = {
	args: BatchArgs;
	shape: RunShape;
	jobs: string[];
	argvs: ReadonlyMap<string, string[]>;
};

/** The spec runner, resolved before any device is leased: `bun`, the preload, the app and the spec env. */
type SpecPlan = {
	bun: string;
	preload: string;
	launch: LaunchPlan;
	env: Omit<SpecEnvOptions, "launchArgs" | "out">;
};

const specDuration = (field: string, value: string | undefined, fallback: string): Result<number> => {
	const ms = parseDuration(value ?? fallback);
	return ms.success ? ms : err(`e2e.spec.${field}: ${ms.error}`);
};

/** `bun` + preload + bundle id + timeouts of the suite's specs; every failure names what to set or install. */
async function specPlan(ctx: CommandContext, deps: BatchDeps, suite: Suite, platform: Platform): AsyncResult<SpecPlan> {
	const bun = findBun(ctx.env, deps.which);
	if (!bun.success) return bun;
	const preload = findPreload(suite.cwd, deps.resolveModule);
	if (!preload.success) return preload;
	const bundleId = await specBundleId(ctx, suite, platform);
	if (!bundleId.success) return bundleId;
	const { spec } = suite.config;
	const timeoutMs = specDuration("timeout", spec?.timeout, DEFAULT_SPEC_TIMEOUT);
	if (!timeoutMs.success) return timeoutMs;
	const actionTimeoutMs = specDuration("actionTimeout", spec?.actionTimeout, DEFAULT_SPEC_ACTION_TIMEOUT);
	if (!actionTimeoutMs.success) return actionTimeoutMs;
	const assertionTimeoutMs = specDuration("assertionTimeout", spec?.assertionTimeout, DEFAULT_SPEC_ASSERTION_TIMEOUT);
	if (!assertionTimeoutMs.success) return assertionTimeoutMs;
	return ok({
		bun: bun.data,
		preload: preload.data,
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
			flowsDir: resolve(suite.configDir, suite.config.flowsDir),
			helperDir: ctx.env.WARDEN_HELPER_DIR ?? deps.helperDir(),
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

function planOf(
	args: BatchArgs,
	legs: BatchLeg[],
	config: E2eSuiteConfig,
	metro: MetroPlan | undefined
): { args: BatchArgs; shape: RunShape } {
	return {
		args: {
			...args,
			jobTimeoutMs: args.jobTimeoutMs ?? config.jobTimeoutMs,
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
		summary: "run the e2e flows a change needs on leased devices; exit 1 if a required flow fails",
		register: (cmd, ctx, done) => {
			withBatchOptions(
				withLeaseOptions(
					withClaimOptions(cmd.argument("[suite]", "e2e.<suite> in warden.config.ts (optional with one suite)"))
				)
			)
				.option("--base <ref>", "compare against merge-base with this ref (default: the suite's base)")
				.option("--platform <platform>", "ios | android (default: the suite's platform)")
				.option("--files <list>", "comma-separated changed files (relative to cwd) instead of git")
				.option("--all", "run every flow of the suite (after include / exclude), skipping the git diff")
				.option("--flows <list>", "run exactly these flow ids / globs (comma-separated), skipping the git diff")
				.option("--required-only", "only run flows with required: true")
				.option("--explain", "print why each flow was selected before running")
				.option("--dry-run", "select and explain, run nothing")
				.option("--report <file>", "also write e2e-report.json here")
				.option("--devices <legs>", "which e2e.<suite>.devices legs run: default | all | <profile,…>")
				.option(
					"--no-shutdown",
					"keep the devices running after the gate passes (default: shut down the ones warden created)"
				)
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
