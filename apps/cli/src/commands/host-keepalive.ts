import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { reportError } from "../output";

async function keepalive(ctx: CommandContext, opts: { host?: string }): Promise<number> {
	if (opts.host === undefined) {
		reportError(ctx, "__host-keepalive", "--host is required");
		return 1;
	}
	const { runKeepalive } = await import("../hosts/keepalive");
	return runKeepalive(ctx, opts.host);
}

export const hostKeepaliveCommand = defineCommand({
	name: "__host-keepalive",
	summary: "renew a host's leases while the local ones live; end them when the host can't back them (internal)",
	hidden: true,
	register: (cmd, ctx, done) => {
		cmd.option("--host <name>").action(async (opts) => done(await keepalive(ctx, opts)));
	},
});
