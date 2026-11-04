import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { reportError } from "../output";

const SCOPE = "__host-send";

async function send(ctx: CommandContext, opts: { perf?: string }): Promise<number> {
	if (opts.perf === undefined) {
		reportError(ctx, SCOPE, "--perf <session id> is required");
		return 1;
	}
	const { packPerfSession, perfSendRefusal } = await import("../hosts/evidence");
	const why = perfSendRefusal(ctx, opts.perf);
	if (why !== undefined) {
		reportError(ctx, SCOPE, why);
		return 1;
	}
	const stream = packPerfSession(ctx, opts.perf);
	for await (const chunk of stream) process.stdout.write(chunk);
	return 0;
}

/** `__host-send --perf <id>`: on a host, a perf session's directory as a tar on stdout, to the holder of its device. */
export const hostSendCommand = defineCommand({
	name: SCOPE,
	summary: "send a perf session's files to the laptop that holds its device, as a tar on stdout (internal)",
	hidden: true,
	register: (cmd, ctx, done) => {
		cmd.option("--perf <id>").action(async (opts) => done(await send(ctx, opts)));
	},
});
