import type { EnsureResult } from "@delacour/warden-core/builds/resolve";
import type { Owner } from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { type HostLease, hostLeases } from "./claim";
import { installOnHost } from "./install";

/** The caller's host lease that `--lease <id>` / `--udid <udid>` names, if they name one. */
export function hostLeaseFor(
	ctx: CommandContext,
	owner: Owner,
	flags: { lease?: string; udid?: string }
): HostLease | undefined {
	if (flags.lease === undefined && flags.udid === undefined) return undefined;
	return hostLeases(ctx.store().listLeasesByOwner(owner)).find(
		(l) => l.id === flags.lease || (flags.udid !== undefined && l.resource.id === flags.udid)
	);
}

export type HostEnsured = EnsureResult & { host: string; hostPath: string };

export type HostEnsureDeps = {
	/** the build for this project and platform, resolved into the cache here (never installed) */
	resolve: () => Promise<Result<EnsureResult>>;
	install?: (ctx: CommandContext, lease: HostLease, appPath: string) => Promise<Result<string>>;
};

/** `app ensure` on a host's device: resolve here (cache, EAS or a local build), then send and install it there. */
export async function ensureOnHost(
	ctx: CommandContext,
	lease: HostLease,
	deps: HostEnsureDeps
): Promise<Result<HostEnsured>> {
	const resolved = await deps.resolve();
	if (!resolved.success) return resolved;
	const { appPath } = resolved.data;
	if (appPath === "") return err(`no cached build at ${resolved.data.hash} to send to ${lease.resource.host}`);
	const installed = await (deps.install ?? installOnHost)(ctx, lease, appPath);
	if (!installed.success) return installed;
	return ok({ ...resolved.data, installed: true, host: lease.resource.host, hostPath: installed.data });
}
