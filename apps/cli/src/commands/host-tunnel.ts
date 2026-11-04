import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { reportError } from "../output";

const SCOPE = "__host-tunnel";

type TunnelOpts = { port?: string; lease?: string; json?: true };

async function tunnel(ctx: CommandContext, opts: TunnelOpts): Promise<number> {
	const port = Number(opts.port);
	if (!Number.isInteger(port) || port < 1 || port > 65_535 || opts.lease === undefined) {
		reportError(ctx, SCOPE, "--port <1-65535> and --lease <id> are required");
		return 1;
	}
	const { serveTunnel } = await import("../hosts/tunnel-serve");
	return serveTunnel(ctx, { port, leaseId: opts.lease });
}

/** `__host-tunnel`: on a host, the far end of `warden dev --host`'s `ssh -R` (checks Metro answers, holds the port). */
export const hostTunnelCommand = defineCommand({
	name: SCOPE,
	summary: "hold a laptop's Metro forward open on this host while its ssh lives (internal)",
	hidden: true,
	register: (cmd, ctx, done) => {
		cmd
			.option("--port <port>")
			.option("--lease <id>")
			.option("--json")
			.action(async (opts) => done(await tunnel(ctx, opts)));
	},
});
