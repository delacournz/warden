import { resolveHeadless } from "@delacour/warden-core/headless";
import { isPortFree } from "@delacour/warden-core/ports";
import type { Platform } from "@delacour/warden-core/types";
import { ok, type Result } from "@delacour/warden-types/result";
import { maybeAutoGc } from "../autogc";
import {
	type ClaimFlagValues,
	claimedJson,
	isPhysicalClaim,
	type PhysicalOptionValues,
	parseClaimFlags,
	resolveOwner,
	resolvePlatform,
	withClaimOptions,
	withNamedPhysical,
	withPhysicalOptions,
} from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import {
	type AppFlagValues,
	appPhaseProgress,
	type ChildHandle,
	claimAll,
	exitCodeOf,
	holdLeases,
	intervalEvery,
	type LeaseArgs,
	type LeaseSessionDeps,
	leasedProgress,
	leasedText,
	parseAppFlags,
	processOnSignal,
	splitOperands,
	withLeaseOptions,
} from "../lease-session";
import { heading, note, reportError } from "../output";
import { reportClaimFailure } from "../physical-lock";
import { canPrompt, pickPhysical, reportPick } from "../physical-pick";
import { withSpinner } from "../spinner-context";

/** Where the child's stdout goes: the terminal, or stderr under `--json` so stdout stays the one JSON line. */
export type RunChildStdout = "inherit" | "stderr";

/** Side effects of `warden run`, injectable for tests. */
export type RunDeps = LeaseSessionDeps & {
	spawn: (cmd: string[], env: Record<string, string | undefined>, stdout: RunChildStdout) => ChildHandle;
};

/** Commander option values of `warden run` (claim options + `--port` / `--app` family). */
export type RunOpts = ClaimFlagValues &
	AppFlagValues &
	PhysicalOptionValues & {
		json?: true;
		port: string[];
	};

type RunArgs = LeaseArgs & { json: boolean };

/** Validated run args from the resolved platform + option values. */
export function parseRunArgs(platform: Platform, opts: RunOpts): Result<RunArgs> {
	const named = withNamedPhysical(opts);
	const flags = parseClaimFlags(platform, named);
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
	release: () => Promise<void>,
	stdout: RunChildStdout
): Promise<number> {
	let child: ChildHandle;
	try {
		child = deps.spawn(cmd, env, stdout);
	} catch (error) {
		await release();
		reportError(ctx, "run", error instanceof Error ? error.message : String(error));
		return 127;
	}
	const stop = holdLeases(ctx, deps, leaseIds, (signal) => child.kill(signal));
	try {
		return await child.exited;
	} finally {
		stop();
		await release();
	}
}

/** Claim (under a spinner) → spawn child with leases in env → heartbeat → release on exit; exit code passthrough. */
async function run(ctx: CommandContext, deps: RunDeps, operands: readonly string[], opts: RunOpts): Promise<number> {
	const fail = (message: string) => {
		reportError(ctx, "run", message);
		return 1;
	};
	const target = splitOperands(ctx.argv, operands);
	if (!target.success) return fail(target.error);
	const platform = await resolvePlatform(ctx, target.data.platformArg);
	if (!platform.success) return fail(platform.error);
	// a physical device is never headless-hidden: only an explicit --headless reaches the claim (which refuses it)
	const physical = isPhysicalClaim(withNamedPhysical(opts));
	const args = parseRunArgs(platform.data, {
		...opts,
		headless: physical ? opts.headless : resolveHeadless({ flag: opts.headless, env: ctx.env }),
	});
	if (!args.success) return fail(args.error);
	const { cmd } = target.data;
	const owner = resolveOwner(ctx);
	// before the spinner and any lease or build: several usable phones are asked about, or refused (ambiguous_device, exit 2)
	const picked = await pickPhysical(ctx, owner, [args.data.flags], {
		prompt: canPrompt(ctx, { json: args.data.json }),
	});
	if (picked.kind !== "ok") return reportPick(ctx, "run", picked);
	const flags = picked.flags[0] ?? args.data.flags;
	const { count, profile } = flags.request;
	if (!args.data.json) heading(ctx, "run", `${platform.data} · ${profile} ×${count} · ${cmd.join(" ")}`);
	const claimed = await withSpinner(
		ctx,
		`claiming ${count} ${profile} ${platform.data} device(s)…`,
		async (sctx, spinner) => {
			const app = args.data.app !== undefined;
			const onLeased = leasedProgress(spinner, ctx.ui.color, app);
			const onAppPhase = appPhaseProgress(spinner, app);
			const result = await claimAll(sctx, deps, owner, {
				...args.data,
				flags,
				...(onLeased ? { onLeased } : {}),
				...(onAppPhase ? { onAppPhase } : {}),
			});
			if (!result.success) spinner.fail(app ? "claim / app install failed" : "claim failed");
			else if (app) spinner.succeed(`app ready on ${result.data.outcome.claimed.length} device(s)`);
			else spinner.succeed(leasedText(result.data.outcome));
			return result;
		}
	);
	// after the claim: its own leases keep the background gc off the devices it just took (16-1)
	maybeAutoGc(ctx);
	if (!claimed.success) return reportClaimFailure(ctx, "run", claimed.error);
	const { outcome, ports, env, release, leaseIds } = claimed.data;
	const summary = { leases: claimedJson(outcome), ports, cmd };
	// one line: the child runs on, so a reader takes the summary from the first stdout line
	if (args.data.json) ctx.out(JSON.stringify(summary));
	else note(ctx, `warden run: leased ${summary.leases.map((l) => `${l.udid} (${l.leaseId})`).join(", ")}`);
	return supervise(ctx, deps, cmd, env, leaseIds, release, args.data.json ? "stderr" : "inherit");
}

/** `warden run [platform] [claim options] [--port …] [--app …] -- <cmd…>` with injectable effects. */
export function createRunCommand(deps: RunDeps): Command {
	return defineCommand({
		name: "run",
		group: "Run",
		summary: "claim devices, run a command with WARDEN_UDIDS set, release on exit",
		register: (cmd, ctx, done) => {
			withLeaseOptions(
				withPhysicalOptions(
					withClaimOptions(
						cmd
							.argument("[platform]", "ios | android (asked for when omitted in a terminal)")
							.argument("[cmd...]", "the command to run, after --")
					)
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
	spawn(cmd, env, stdout) {
		const proc = Bun.spawn(cmd, {
			env,
			stdin: "inherit",
			stdout: stdout === "stderr" ? 2 : "inherit",
			stderr: "inherit",
		});
		return {
			exited: proc.exited.then((code) => exitCodeOf(proc, code)),
			kill: (signal) => proc.kill(signal),
		};
	},
	onSignal: processOnSignal,
	every: intervalEvery,
};

export const runCommand: Command = createRunCommand(defaultRunDeps);
