import { providerFor } from "@delacour/warden-core/host-deps";
import type { LeaseHost } from "@delacour/warden-leasing/lease-host";
import { stopHelperAfter } from "./agent-ui/stop-helper-after";
import { appHostFromContext, type CommandContext } from "./context";

/**
 * The context as a {@link LeaseHost}: the app host (host + store + git-facts memo) plus the golden-aware
 * device providers and the resident-helper stop the lease engine takes from its embedder.
 */
export function leaseHostFromContext(ctx: CommandContext): LeaseHost {
	const host = appHostFromContext(ctx);
	return {
		...host,
		...(ctx.hostFacts ? { hostFacts: ctx.hostFacts } : {}),
		providerFor: (platform, owner, opts) => providerFor(platform, host, owner, opts),
		stopHelper: (udid) => stopHelperAfter(ctx)(udid),
	};
}
