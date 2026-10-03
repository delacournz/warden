import { join } from "node:path";
import type { Affected, Suite } from "@delacour/warden-core/affected/affected";
import type { E2eSuiteConfig } from "@delacour/warden-core/affected/affected.schema";
import type { SelectedFlow, Selection } from "@delacour/warden-core/affected/select";
import { readySpec } from "@delacour/warden-core/batch/preset";
import { appSwitches } from "@delacour/warden-core/builds/app-option.schema";
import type { Platform } from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { DeviceSetup, DeviceSetupSpec } from "../batch/setup";
import { type ClaimFlagValues, withClaimOptions } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { type AppFlagValues, withLeaseOptions } from "../lease-session";
import { emit } from "../output";
import { type AffectedOpts, explain, runAffected, selectedFlows } from "./affected";
import {
	attemptKey,
	type BatchDeps,
	defaultBatchDeps,
	parseBatchArgs,
	runSession,
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
		record?: string;
		logs?: string;
		tui: boolean;
		report?: string;
		dryRun?: true;
	};

/** One flow's outcome in `e2e-report.json`. */
export type FlowVerdict = SelectedFlow & {
	verdict: "passed" | "failed" | "not-run";
	attempts: number;
	/** the device as the flow's last failed attempt left it (png), when one could be captured */
	screenshot?: string;
};

export type E2eReport = {
	suite: string;
	platform: Platform;
	base?: string;
	ok: boolean;
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
		...(app.clean ? { clean: true as const } : {}),
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

/** `runner` argv for one flow: `{flow}` = its id, `{flowPath}` = its file; batch expands the rest. */
export function runnerArgv(runner: readonly string[], flow: SelectedFlow): string[] {
	return runner.map((arg) => arg.replaceAll("{flowPath}", flow.file).replaceAll("{flow}", flow.id));
}

/** Batch outcome → per-flow verdicts; `ok` = every required flow passed. */
export function verdicts(
	flows: readonly SelectedFlow[],
	session: SessionResult
): { ok: boolean; flows: FlowVerdict[] } {
	const results = session.summary?.results ?? [];
	const failed = new Set(session.summary?.failed ?? []);
	const out = flows.map((flow): FlowVerdict => {
		const attempts = results.filter((r) => r.job === flow.id).length;
		const verdict = attempts === 0 ? "not-run" : failed.has(flow.id) ? "failed" : "passed";
		const shots = results.filter((r) => r.job === flow.id && r.exitCode !== 0);
		const screenshot = shots
			.map((r) => session.screenshots?.get(attemptKey(r)))
			.reverse()
			.find((path) => path !== undefined);
		return { ...flow, verdict, attempts, ...(screenshot !== undefined ? { screenshot } : {}) };
	});
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

/** Failed / not-run flows, then the one-line gate verdict. */
function printVerdict(ctx: CommandContext, report: E2eReport): void {
	const { color } = ctx.ui;
	for (const flow of report.flows.filter((f) => f.verdict !== "passed")) {
		const tag = flow.required ? color.red(flow.verdict) : color.yellow(`${flow.verdict} (optional)`);
		ctx.err(`warden e2e: ${flow.id} ${tag}`);
	}
	const passed = report.flows.filter((f) => f.verdict === "passed").length;
	const line = `warden e2e: ${passed}/${report.flows.length} flow(s) passed — ${report.ok ? "gate passed" : "gate failed"}`;
	ctx.err((report.ok ? color.green : color.red)(line));
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
	return ok({ affected: affected.data, selection: selection.data, flows });
}

/**
 * `warden e2e [suite]`: the flows the change needs (see `warden affected`), run on leased devices
 * like `warden batch`, each `passes` times. Exit 0 when every required flow passed (optional
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
	const base = {
		suite: suite.name,
		platform: selection.platform,
		...(affected.base !== undefined ? { base: affected.base } : {}),
	};
	if (flows.length === 0 || opts.dryRun) {
		if (flows.length === 0) ctx.err(ctx.ui.color.green("warden e2e: no affected flows — nothing to run"));
		const notRun = flows.map((f): FlowVerdict => ({ ...f, verdict: "not-run", attempts: 0 }));
		await publish(ctx, deps, opts, { ...base, ok: true, flows: notRun });
		return 0;
	}
	// --json is the e2e report here, not batch.json
	const { json: _json, ...batchOpts } = suiteOpts(suite, opts, passed);
	const byId = new Map(flows.map((f) => [f.id, f]));
	const args = parseBatchArgs(selection.platform, batchOpts, ctx.cwd, {
		jobs: { kind: "list", jobs: [...byId.keys()] },
		cwd: suite.cwd,
		...(suite.config.env ? { env: suite.config.env } : {}),
	});
	if (!args.success) return fail(args.error);
	const unsupported = platformError(suite.config, selection.platform);
	if (unsupported) return fail(unsupported);
	const { runner } = suite.config;
	const session = await runSession(ctx, deps, args.data, [...byId.keys()], runner, {
		name: "e2e",
		setup: deviceSetup(suite.config),
		argvFor: (job) => {
			const flow = byId.get(job);
			return flow ? runnerArgv(runner, flow) : runner;
		},
	});
	const result = verdicts(flows, session);
	const report: E2eReport = {
		...base,
		ok: result.ok,
		...(session.batchDir ? { batchDir: session.batchDir } : {}),
		flows: result.flows,
		...(session.setups ? { setup: session.setups } : {}),
	};
	await publish(ctx, deps, opts, report);
	if (session.code === 130) return 130;
	printVerdict(ctx, report);
	return result.ok ? 0 : 1;
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
					withClaimOptions(cmd.argument("[suite]", "e2e.<suite> in warden.config.json (optional with one suite)"))
				)
			)
				.option("--base <ref>", "compare against merge-base with this ref (default: the suite's base)")
				.option("--platform <platform>", "ios | android (default: the suite's platform)")
				.option("--files <list>", "comma-separated changed files (relative to cwd) instead of git")
				.option("--required-only", "only run flows with required: true")
				.option("--explain", "print why each flow was selected before running")
				.option("--dry-run", "select and explain, run nothing")
				.option("--report <file>", "also write e2e-report.json here")
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
