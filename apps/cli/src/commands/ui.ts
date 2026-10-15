import { withUiOptions } from "../agent-ui/run";
import { uiStatus } from "../agent-ui/status";
import { defineCommand } from "../command";

/**
 * `warden ui <subcommand>`: drive a leased device for agents. Every subcommand is one `cmd.command(...)`
 * calling a function in `agent-ui/*.ts`, takes the options of `withUiOptions`, and honours the lease
 * rules of `resolveUiDevice` (the hook's `ensureCallerLease`). Exit codes: 0 ok · 1 failed/usage · 2 lease
 * · 3 engine unavailable · 4 stale ref · 130 interrupted.
 */
export const uiCommand = defineCommand({
	name: "ui",
	summary: "drive a leased simulator / emulator (agents): status, …",
	register: (cmd, ctx, done) => {
		withUiOptions(cmd.command("status").description("device, lease, helper and recording state")).action(async (opts) =>
			done(await uiStatus(ctx, opts))
		);
	},
});
