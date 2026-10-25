import type { CommandContext } from "../context";

/** Host facts `warden perf doctor` reads that are not a plain `ctx.exec` call; tests inject fakes. */
export type PerfHostDeps = {
	platform: NodeJS.Platform;
	/** the Metro serving this device (`--metro`-less lookup: WARDEN_METRO_URL, the device's state.json, the owner's leased ports) */
	metro: (ctx: CommandContext, udid: string | undefined) => Promise<string | undefined>;
};

export const defaultPerfHostDeps: PerfHostDeps = {
	platform: process.platform,
	metro: async (ctx, udid) => {
		const { findMetro } = await import("@delacour/warden-e2e/devtools/metro");
		const { metroOwner } = await import("../metro");
		const { readState } = await import("../agent-ui/state");
		const { resolveOwner } = await import("../claim-flags");
		const { sameOwner } = await import("@delacour/warden-core/types");
		const owner = resolveOwner(ctx);
		const stateUrl = udid === undefined ? undefined : readState(ctx, udid).metroUrl;
		const portLeases = ctx
			.store()
			.listLeases()
			.flatMap((l) => (l.resource.kind === "port" && sameOwner(l.owner, owner) ? [l.resource.port] : []));
		const found = await findMetro({
			...(ctx.env.WARDEN_METRO_URL === undefined ? {} : { env: ctx.env.WARDEN_METRO_URL }),
			...(stateUrl === undefined ? {} : { stateMetroUrl: stateUrl }),
			portLeases,
			probe: async (port) => {
				const probed = await metroOwner(ctx.exec, port, ctx.cwd);
				return probed.kind === "ours" ? "ours" : probed.kind === "foreign" ? "foreign" : "none";
			},
		});
		return found?.url;
	},
};
