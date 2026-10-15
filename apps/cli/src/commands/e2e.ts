import { join, relative, resolve } from "node:path";
import type { Affected, Suite } from "@delacour/warden-core/affected/affected";
import type { E2eDeviceLeg, E2eSuiteConfig } from "@delacour/warden-core/affected/affected.schema";
import type { SelectedFlow, Selection } from "@delacour/warden-core/affected/select";
import { readySpec } from "@delacour/warden-core/batch/preset";
import type { JobResult } from "@delacour/warden-core/batch/schedule";
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
import type { TrackedFlow } from "../batch/flow-progress";
import type { DeviceSetup, DeviceSetupSpec } from "../batch/setup";
import { type ClaimFlagValues, parseClaimFlags, withClaimOptions } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { findBun, findPreload, runnerArgv, type SpecEnvOptions, shardFlows, specEnv } from "../e2e/bun-runner";
import { type LaunchPlan, specBundleId, specLaunchArgs } from "../e2e/launch";
import { type AppFlagValues, withLeaseOptions } from "../lease-session";
import { emit } from "../output";
import { type AffectedOpts, explain, runAffected, selectedFlows } from "./affected";
import {
	attemptKey,
	type BatchArgs,
	type BatchDeps,
	type BatchLeg,
	defaultBatchDeps,
	legJob,
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

/** One flow's outcome in `e2e-report.json`. */
export type FlowVerdict = SelectedFlow & {
	/** the device leg this verdict is for (suites with `devices`) */
	leg?: string;
	verdict: "passed" | "failed" | "not-run";
	attempts: number;
	/** the device the flow's last failed attempt ran on */
	device?: { udid: string; name: string };
	/** the runner output of that attempt */
	log?: string;
	/** the device as the flow's last failed attempt left it (png), when one could be captured */
	screenshot?: string;
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

/** How the batch jobs map back to flows: the legs that ran, and in a `single` run the shard job each flow is in. */
export type RunShape = { legs: ReadonlyArray<string | undefined>; shardOf?: ReadonlyMap<string, string> };

const ONE_LEG: RunShape = { legs: [undefined] };

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

/** device / log / screenshot of a flow's failed attempts (the last one's device and log; the latest screenshot there is). */
function lastFailure(session: SessionResult, failed: readonly JobResult[]): Partial<FlowVerdict> {
	const last = failed.at(-1);
	if (!last) return {};
	const screenshot = failed
		.map((r) => session.screenshots?.get(attemptKey(r)))
		.reverse()
		.find((path) => path !== undefined);
	const log = session.logs?.get(attemptKey(last));
	const name = session.devices?.find((d) => d.worker === last.worker)?.name ?? last.udid;
	return {
		device: { udid: last.udid, name },
		...(log !== undefined ? { log } : {}),
		...(screenshot !== undefined ? { screenshot } : {}),
	};
}

/**
 * Batch outcome → per-flow verdicts (one per leg that ran); `ok` = every required flow passed on
 * every leg. In a `single` run the flows of a shard share its one job.
 */
export function verdicts(
	flows: readonly SelectedFlow[],
	session: SessionResult,
	shape: RunShape = ONE_LEG
): { ok: boolean; flows: FlowVerdict[] } {
	const results = session.summary?.results ?? [];
	const failed = new Set(session.summary?.failed ?? []);
	const qualified = shape.legs.length > 1;
	const out = shape.legs.flatMap((leg) =>
		flows.map((flow): FlowVerdict => {
			const job = legJob(shape.shardOf?.get(flow.id) ?? flow.id, qualified ? leg : undefined);
			const ran = results.filter((r) => r.job === job);
			const verdict = ran.length === 0 ? "not-run" : failed.has(job) ? "failed" : "passed";
			const failure = lastFailure(
				session,
				ran.filter((r) => r.exitCode !== 0)
			);
			return { ...flow, ...(leg !== undefined ? { leg } : {}), verdict, attempts: ran.length, ...failure };
		})
	);
	const ok = session.summary !== undefined && out.every((f) => !f.required || f.verdict === "passed");
	return { ok, flows: out };
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

/** Failed / not-run flows, then the one-line gate verdict. */
function printVerdict(ctx: CommandContext, report: E2eReport): void {
	const { color } = ctx.ui;
	for (const flow of report.flows.filter((f) => f.verdict !== "passed")) {
		const tag = flow.required ? color.red(flow.verdict) : color.yellow(`${flow.verdict} (optional)`);
		const leg = flow.leg !== undefined ? ` [${flow.leg}]` : "";
		ctx.err(`warden e2e: ${flow.id}${leg} ${tag}${failureDetail(flow)}`);
	}
	const passed = report.flows.filter((f) => f.verdict === "passed").length;
	const line = `warden e2e: ${passed}/${report.flows.length} flow(s) passed — ${report.ok ? "gate passed" : "gate failed"}`;
	ctx.err((report.ok ? color.green : color.red)(line));
}

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
	const result = verdicts(flows, session, shape);
	const report: E2eReport = {
		...base,
		...(single ? { mode: "single" as const } : {}),
		ok: result.ok,
		headless,
		...(session.batchDir ? { batchDir: session.batchDir } : {}),
		flows: result.flows,
		...(session.setups ? { setup: session.setups } : {}),
	};
	await publish(ctx, deps, opts, report);
	if (session.code === 130) return 130;
	printVerdict(ctx, report);
	return result.ok ? 0 : 1;
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
		...(shape.shardOf ? { flows: trackedFlows(suite, flows) } : {}),
		// a passed gate frees the sims; a failed one leaves them up to inspect
		...(shutdown ? { shutdownIf: (summary) => verdicts(flows, { code: 0, summary }, shape).ok } : {}),
		argvFor: (job) => argvs.get(job) ?? [],
		jobEnv: (job) =>
			specEnv({
				...spec.env,
				launchArgs: specLaunchArgs(spec.launch, job.metroUrl),
				out: join(job.batchDir, "e2e", `${job.worker}-${job.seq}`),
			}),
	};
}

/** `mode: "single"`: the flows as the runner prints them (relative to the suite cwd), for live progress (`results.jsonl` replaces this scraping). */
function trackedFlows(suite: Suite, flows: readonly SelectedFlow[]): TrackedFlow[] {
	return flows.map((f) => ({ id: f.id, path: relative(suite.cwd, f.file) }));
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
