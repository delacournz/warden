import { hostDeps } from "@delacour/warden-core/host-deps";
import type { LeaseHost } from "@delacour/warden-leasing/lease-host";
import { stopHelperAfter } from "./agent-ui/stop-helper-after";
import { type CommandContext, contextBuilder } from "./context";

export class LeaseHostBuilder {
	/**
	 * The context as a {@link LeaseHost}: the app host (host + store + git-facts memo) plus the golden-aware
	 * device providers and the resident-helper stop the lease engine takes from its embedder.
	 */
	leaseHostFromContext(ctx: CommandContext): LeaseHost {
		const host = contextBuilder.appHostFromContext(ctx);
		return {
			...host,
			...(ctx.hostFacts ? { hostFacts: ctx.hostFacts } : {}),
			providerFor: (platform, owner, opts) => hostDeps.providerFor(platform, host, owner, opts),
			stopHelper: (udid) => stopHelperAfter(ctx)(udid),
		};
	}
}

export const leaseHostBuilder = new LeaseHostBuilder();
