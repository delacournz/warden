import { isPortFree } from "@delacour/warden-core/ports";
import type { Platform } from "@delacour/warden-core/types";
import { ok, type Result } from "@delacour/warden-types/result";
import { maybeAutoGc } from "../autogc";
import {
	type ClaimFlagValues,
	claimedJson,
	parseClaimFlags,
	resolveOwner,
	resolvePlatform,
	withClaimOptions,
} from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import {
	type AppFlagValues,
	type ChildHandle,
	claimAll,
	exitCodeOf,
	holdLeases,
	intervalEvery,
	type LeaseArgs,
	type LeaseSessionDeps,
	parseAppFlags,
	processOnSignal,
	splitOperands,
	withLeaseOptions,
} from "../lease-session";
import { emit } from "../output";
import { withSpinner } from "../spinner-context";

/** Side effects of `warden run`, injectable for tests. */
export type RunDeps = LeaseSessionDeps & {
	spawn: (cmd: string[], env: Record<string, string | undefined>) => ChildHandle;
};

/** Commander option values of `warden run` (claim options + `--port` / `--app` family). */
export type RunOpts = ClaimFlagValues &
	AppFlagValues & {
		json?: true;
		port: string[];
	};

type RunArgs = LeaseArgs & { json: boolean };

/** Validated run args from the resolved platform + option values. */
export function parseRunArgs(platform: Platform, opts: RunOpts): Result<RunArgs> {
	const flags = parseClaimFlags(platform, opts);
	if (!flags.success) return flags;
	const app = parseAppFlags(opts);
	if (!app.success) return app;
	const args: RunArgs = { flags: flags.data, ports: opts.port, json: opts.json === true };
	if (app.data) args.app = app.data;
	return ok(args);
}

/** Spawn the child, heartbeat `leaseIds`, forward SIGINT/SIGTERM; always `release()` at the end. */
async function supervise(
	ctx: CommandContext,
	deps: RunDeps,
	cmd: string[],
	env: Record<string, string | undefined>,
	leaseIds: string[],
	release: () => void
): Promise<number> {
	let child: ChildHandle;
	try {
		child = deps.spawn(cmd, env);
	} catch (error) {
		release();
		ctx.err(ctx.ui.color.red(`warden run: ${error instanceof Error ? error.message : String(error)}`));
		return 127;
	}
	const stop = holdLeases(ctx, deps, leaseIds, (signal) => child.kill(signal));
	try {
		return await child.exited;
	} finally {
		stop();
		release();
	}
}

/** Claim (under a spinner) → spawn child with leases in env → heartbeat → release on exit; exit code passthrough. */
async function run(ctx: CommandContext, deps: RunDeps, operands: readonly string[], opts: RunOpts): Promise<number> {
	const { color } = ctx.ui;
	const fail = (message: string) => {
		ctx.err(color.red(`warden run: ${message}`));
		return 1;
	};
	const target = splitOperands(ctx.argv, operands);
	if (!target.success) return fail(target.error);
	const platform = await resolvePlatform(ctx, target.data.platformArg);
	if (!platform.success) return fail(platform.error);
	const args = parseRunArgs(platform.data, opts);
	if (!args.success) return fail(args.error);
	const { cmd } = target.data;
	const owner = resolveOwner(ctx);
	maybeAutoGc(ctx);
	const { count, profile } = args.data.flags.request;
	const claimed = await withSpinner(
		ctx,
		`claiming ${count} ${profile} ${platform.data} device(s)…`,
		async (sctx, spinner) => {
			const result = await claimAll(sctx, deps, owner, args.data);
			if (result.success) spinner.succeed(`leased ${result.data.outcome.claimed.map((c) => c.device.name).join(", ")}`);
			else spinner.fail("claim failed");
			return result;
		}
	);
	if (!claimed.success) return fail(claimed.error);
	const { outcome, ports, env, release, leaseIds } = claimed.data;
	const summary = { leases: claimedJson(outcome), ports, cmd };
	if (args.data.json) emit(ctx, true, summary, "");
	else ctx.err(color.dim(`warden run: leased ${summary.leases.map((l) => `${l.udid} (${l.leaseId})`).join(", ")}`));
	return supervise(ctx, deps, cmd, env, leaseIds, release);
}

/** `warden run [platform] [claim options] [--port …] [--app …] -- <cmd…>` with injectable effects. */
export function createRunCommand(deps: RunDeps): Command {
	return defineCommand({
		name: "run",
		summary: "claim devices, run a command with WARDEN_UDIDS set, release on exit",
		register: (cmd, ctx, done) => {
			withLeaseOptions(
				withClaimOptions(
					cmd
						.argument("[platform]", "ios | android (asked for when omitted in a terminal)")
						.argument("[cmd...]", "the command to run, after --")
				)
			)
				.addHelpText("after", "\nExample:\n  warden run ios --count 2 --port 8091:20 -- bun e2e")
				.action(async (platform, rest, opts) =>
					done(await run(ctx, deps, platform === undefined ? rest : [platform, ...rest], opts))
				);
		},
	});
}

export const defaultRunDeps: RunDeps = {
	pid: process.pid,
	isPortFree: (port) => isPortFree(port),
	spawn(cmd, env) {
		const proc = Bun.spawn(cmd, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
		return {
			exited: proc.exited.then((code) => exitCodeOf(proc, code)),
			kill: (signal) => proc.kill(signal),
		};
	},
	onSignal: processOnSignal,
	every: intervalEvery,
};

export const runCommand: Command = createRunCommand(defaultRunDeps);
