import { type AppDeps, AppPreparer, appLookup, defaultAppDeps } from "@delacour/warden-builds/prepare";
import { Repacker, type RepackInput, type RepackResult } from "@delacour/warden-builds/repack";
import { ownerResolver } from "@delacour/warden-leasing/owner";
import type { Platform } from "@delacour/warden-store/types";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { claimFlagsHelpers } from "../claim-flags";
import { CliCommand, type CommandNode } from "../command";
import { type CommandContext, contextBuilder } from "../context";
import { output } from "../output";
import { projectContextHelpers } from "../project-context";
import { spinnerContext } from "../spinner-context";

/** Runs one repack; the real one is `new Repacker(input).run()`. */
export type RepackRun = (input: RepackInput) => AsyncResult<RepackResult>;

type RepackOpts = { project?: string; force?: true; json?: true };

/** What `warden repack` reports: the repack's keys and artifact, or why one cannot be made. */
export type RepackReport =
	| {
			result: "reused" | "repacked";
			platform: Platform;
			baseHash: string;
			hash: string;
			jsKey: string;
			artifact: string;
			bundleMs?: number;
	  }
	| { result: "fallback"; platform: Platform; reason: string };

export class RepackCommand extends CliCommand {
	override readonly name = "repack";
	override readonly group = "Builds";
	override readonly summary =
		"bundle this worktree's JS into the cached simulator build (seconds; builds the base once per native fingerprint)";

	constructor(
		private readonly deps: AppDeps,
		run?: RepackRun
	) {
		super();
		this.run = run ?? this.runRepack;
	}

	private readonly run: RepackRun;

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd
			.argument("[platform]", "ios | android (asked for when omitted in a terminal)")
			.option("--project <dir>", "project directory (default: cwd)")
			.option("--force", "repack even when this JS is already cached")
			.option("--json", "machine-readable output")
			.action(async (platform, opts) => done(await this.repackCmd(ctx, this.deps, this.run, platform, opts)));
	}

	private readonly runRepack: RepackRun = (input) => new Repacker(input).run();

	private report(platform: Platform, result: RepackResult): RepackReport {
		if (result.kind === "fallback") return { result: "fallback", platform, reason: result.reason };
		return {
			result: result.kind,
			platform,
			baseHash: result.baseHash,
			hash: result.hash,
			jsKey: result.jsKey,
			artifact: result.artifact,
			...(result.bundleMs !== undefined ? { bundleMs: result.bundleMs } : {}),
		};
	}

	/** Ensure the simulator base, then bundle + repack this worktree's JS over it (never installs). */
	private async repack(
		ctx: CommandContext,
		deps: AppDeps,
		run: RepackRun,
		platform: Platform,
		opts: RepackOpts
	): AsyncResult<RepackReport> {
		const start = appLookup.projectStart(ctx, opts.project);
		if (!start.success) return start;
		const project = await projectContextHelpers.projectContextFor(ctx, { start: start.data });
		if (!project.success) return project;
		const { kind: _kind, ...input } = new AppPreparer(contextBuilder.appHostFromContext(ctx), deps).kindAppInput(
			ownerResolver.resolve(ctx),
			platform,
			project.data,
			"simulator",
			{
				eas: false,
				build: true,
				...(opts.force ? { force: true } : {}),
			}
		);
		const result = await run(input);
		return result.success ? resultFactory.ok(this.report(platform, result.data)) : resultFactory.err(result.error);
	}

	private text(ctx: CommandContext, r: RepackReport): string {
		const { color } = ctx.ui;
		if (r.result === "fallback") {
			return `${color.yellow("no repack")}: ${r.reason}\n${color.dim("`warden app ensure --kind simulator` builds the release kind instead")}`;
		}
		const took = r.bundleMs !== undefined ? ` in ${(r.bundleMs / 1000).toFixed(1)}s` : "";
		return [
			`${color.green(r.result)}${r.result === "repacked" ? took : ""}: ${r.artifact}`,
			color.dim(`base ${r.baseHash} · jsKey ${r.jsKey} · hash ${r.hash}`),
		].join("\n");
	}

	/** `warden repack <platform>`: exit 0 on a repack (made or cached), 1 on an error or when the base cannot take one. */
	private async repackCmd(
		ctx: CommandContext,
		deps: AppDeps,
		run: RepackRun,
		platformArg: string | undefined,
		opts: RepackOpts
	): Promise<number> {
		const platform = await claimFlagsHelpers.resolvePlatform(ctx, platformArg);
		if (!platform.success) {
			output.reportError(ctx, "repack", platform.error);
			return 1;
		}
		if (!opts.json) output.heading(ctx, "repack", platform.data);
		const res = await spinnerContext.withSpinner(ctx, `repacking the ${platform.data} JS…`, async (sctx, spinner) => {
			const done = await this.repack(sctx, deps, run, platform.data, opts);
			if (!done.success) spinner.fail(`${platform.data} repack failed`);
			else if (done.data.result === "fallback") spinner.fail(`${platform.data} repack not possible`);
			else spinner.succeed(`${platform.data} JS ${done.data.result}`);
			return done;
		});
		if (!res.success) {
			output.reportError(ctx, "repack", res.error);
			return 1;
		}
		output.emit(ctx, opts.json === true, res.data, this.text(ctx, res.data));
		return res.data.result === "fallback" ? 1 : 0;
	}
}

export const repackCommand = new RepackCommand(defaultAppDeps).definition();
