import { wardenHome } from "@delacour/warden-core/store";
import type { Lease } from "@delacour/warden-core/types";
import type { AsyncResult } from "@delacour/warden-types/result";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { VIEWER_BINARY, viewerAsset } from "../npm/viewer";
import { emit, note, reportError, warn } from "../output";
import type { ViewerScope } from "../remote/api.types";
import { withSpinner } from "../spinner-context";
import { currentBuild } from "../update/build-info";
import { tarExtract } from "../update/fetch-asset";

type ViewOpts = { watch?: true; detach?: true; json?: true };

export type AttachOptions = { scope: ViewerScope; detach: boolean; json: boolean; report: boolean };

/** The viewer executable, downloading it on first use (a spinner covers the download). */
async function ensureViewer(ctx: CommandContext): AsyncResult<string> {
	const { locateViewer, fetchViewer } = await import("../remote/viewer");
	const input = {
		env: ctx.env,
		platform: ctx.os ?? process.platform,
		arch: process.arch,
		version: currentBuild().version,
		wardenHome: wardenHome(ctx.env),
	};
	const found = locateViewer(input);
	if (found) return { success: true, data: found };
	return withSpinner(ctx, "downloading the warden viewer…", async (sctx, spinner) => {
		const fetched = await fetchViewer({
			...input,
			fetch: ctx.fetch ?? ((url) => fetch(url)),
			extract: (target) => tarExtract(sctx.exec, viewerAsset(target), VIEWER_BINARY[target]),
		});
		if (fetched.success) spinner.succeed(`downloaded the warden viewer (${fetched.data.url})`);
		else spinner.fail("viewer download failed");
		return fetched.success ? { success: true as const, data: fetched.data.binary } : fetched;
	});
}

/** Stop the hosted device behind `lease` and drop the lease: the window's Shut down choice, or Ctrl+C. */
async function endRemoteLease(ctx: CommandContext, lease: Lease): Promise<Ended> {
	const [{ stopRemoteLeases }, { releaseDevices }] = await Promise.all([
		import("../remote/claim"),
		import("../device-lease"),
	]);
	const remote = await stopRemoteLeases(ctx, [lease]);
	await releaseDevices(ctx, [lease.id]);
	return { remoteStopped: remote.stopped, notes: remote.notes };
}

type Ended = { remoteStopped: string[]; notes: string[] };

/** The `warden view` summary line / JSON once the viewer has returned. */
function reportViewer(
	ctx: CommandContext,
	lease: Lease,
	opts: AttachOptions,
	r: { exitCode: number; pid: number; detached: boolean; ended: Ended | undefined }
): void {
	const remoteId = lease.resource.kind === "remote-device" ? lease.resource.id : lease.id;
	const closed = r.ended
		? `viewer closed; stopped remote ${remoteId} and released ${lease.id}`
		: `viewer closed (exit ${r.exitCode}); ${remoteId} keeps running (lease ${lease.id}, TTL applies)`;
	const text = r.detached
		? `viewer opened on ${remoteId} (pid ${r.pid}); it closes with its token, ~30 min, and the lease TTL applies`
		: closed;
	emit(
		ctx,
		opts.json,
		{
			leaseId: lease.id,
			remoteId,
			scope: opts.scope,
			detached: r.detached,
			exitCode: r.exitCode,
			...(r.detached ? { pid: r.pid } : {}),
			...(r.ended ? { released: true, remoteStopped: r.ended.remoteStopped } : {}),
		},
		r.exitCode === 0 ? ctx.ui.color.green(text) : ctx.ui.color.yellow(text)
	);
}

/**
 * Open the viewer on `lease` and stay attached until the window closes; with `detach` it returns as soon as the
 * viewer has its token. Ctrl+C, or Shut down in the window's close prompt, stops the hosted device and releases the
 * lease; Keep running leaves both (the lease TTL applies). Returns the command's exit code: the viewer's own.
 */
export async function attachViewer(
	ctx: CommandContext,
	scope: string,
	lease: Lease,
	opts: AttachOptions
): Promise<number> {
	const binary = await ensureViewer(ctx);
	if (!binary.success) {
		reportError(ctx, scope, binary.error);
		return 1;
	}
	const { openViewer } = await import("../remote/viewer");
	const abort = new AbortController();
	const onSigint = () => abort.abort();
	process.once("SIGINT", onSigint);
	const outcome = await openViewer(ctx, {
		binary: binary.data,
		lease,
		scope: opts.scope,
		detach: opts.detach,
		signal: abort.signal,
	});
	process.off("SIGINT", onSigint);
	if (!outcome.success) {
		reportError(ctx, scope, outcome.error);
		return 1;
	}
	const { exitCode, events, pid, detached } = outcome.data;
	const failure = events.filter((e) => e.event === "error").at(-1);
	if (failure) reportError(ctx, scope, `viewer: ${failure.message}`);
	const release = !detached && (abort.signal.aborted || outcome.data.release);
	const ended = release ? await endRemoteLease(ctx, lease) : undefined;
	for (const n of ended?.notes ?? []) warn(ctx, n);
	if (!opts.report) {
		if (ended && !opts.json)
			note(ctx, `released ${lease.id}; stopped remote ${ended.remoteStopped.join(" ") || "(none)"}`);
		return exitCode;
	}
	reportViewer(ctx, lease, opts, { exitCode, pid, detached, ended });
	return exitCode;
}

async function view(ctx: CommandContext, arg: string | undefined, opts: ViewOpts): Promise<number> {
	const { pickRemoteLease } = await import("../remote/viewer");
	const lease = pickRemoteLease(ctx, arg);
	if (!lease.success) {
		reportError(ctx, "view", lease.error);
		return 1;
	}
	if (!opts.json && opts.detach) note(ctx, "detached: no heartbeats, so the lease TTL applies");
	return attachViewer(ctx, "view", lease.data, {
		scope: opts.watch ? "view" : "drive",
		detach: opts.detach === true,
		json: opts.json === true,
		report: true,
	});
}

export const viewCommand = defineCommand({
	name: "view",
	group: "Account",
	summary: "open a hosted device in the warden viewer window",
	register: (cmd, ctx, done) => {
		cmd
			.argument("[leaseId|remoteId]", "remote lease or hosted device id (default: your only remote lease)")
			.option("--watch", "read-only: no taps, swipes or typing")
			.option("--detach", "leave the window open and return (one 30 min token; the lease TTL applies)")
			.option("--json", "machine-readable output")
			.action(async (arg, opts) => done(await view(ctx, arg, opts)));
	},
});
