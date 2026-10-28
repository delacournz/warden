import { type RepackResult, repackApp } from "@delacour/warden-core/builds/repack";
import type { Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { resolveOwner, resolvePlatform } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, heading, reportError } from "../output";
import { projectContextFor } from "../project-context";
import { withSpinner } from "../spinner-context";
import { type AppDeps, defaultAppDeps, kindAppInput, projectStart } from "./app";

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

function report(platform: Platform, result: RepackResult): RepackReport {
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
async function repack(
	ctx: CommandContext,
	deps: AppDeps,
	run: typeof repackApp,
	platform: Platform,
	opts: RepackOpts
): AsyncResult<RepackReport> {
	const start = projectStart(ctx, opts.project);
	if (!start.success) return start;
	const project = await projectContextFor(ctx, { start: start.data });
	if (!project.success) return project;
	const { kind: _kind, ...input } = kindAppInput(ctx, deps, resolveOwner(ctx), platform, project.data, "simulator", {
		eas: false,
		build: true,
		...(opts.force ? { force: true } : {}),
	});
	const result = await run(input);
	return result.success ? ok(report(platform, result.data)) : err(result.error);
}

function text(ctx: CommandContext, r: RepackReport): string {
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
async function repackCmd(
	ctx: CommandContext,
	deps: AppDeps,
	run: typeof repackApp,
	platformArg: string | undefined,
	opts: RepackOpts
): Promise<number> {
	const platform = await resolvePlatform(ctx, platformArg);
	if (!platform.success) {
		reportError(ctx, "repack", platform.error);
		return 1;
	}
	if (!opts.json) heading(ctx, "repack", platform.data);
	const res = await withSpinner(ctx, `repacking the ${platform.data} JS…`, async (sctx, spinner) => {
		const done = await repack(sctx, deps, run, platform.data, opts);
		if (!done.success) spinner.fail(`${platform.data} repack failed`);
		else if (done.data.result === "fallback") spinner.fail(`${platform.data} repack not possible`);
		else spinner.succeed(`${platform.data} JS ${done.data.result}`);
		return done;
	});
	if (!res.success) {
		reportError(ctx, "repack", res.error);
		return 1;
	}
	emit(ctx, opts.json === true, res.data, text(ctx, res.data));
	return res.data.result === "fallback" ? 1 : 0;
}

export function createRepackCommand(deps: AppDeps, run: typeof repackApp = repackApp): Command {
	return defineCommand({
		name: "repack",
		group: "Builds",
		summary:
			"bundle this worktree's JS into the cached simulator build (seconds; builds the base once per native fingerprint)",
		register: (cmd, ctx, done) => {
			cmd
				.argument("[platform]", "ios | android (asked for when omitted in a terminal)")
				.option("--project <dir>", "project directory (default: cwd)")
				.option("--force", "repack even when this JS is already cached")
				.option("--json", "machine-readable output")
				.action(async (platform, opts) => done(await repackCmd(ctx, deps, run, platform, opts)));
		},
	});
}

export const repackCommand: Command = createRepackCommand(defaultAppDeps);
