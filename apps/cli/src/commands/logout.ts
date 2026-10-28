import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, note, success } from "../output";
import { clearCredentials } from "../remote/credentials";
import { authedApi } from "../remote/session";

/** Revoke the session server-side (best effort: offline still logs out) and forget the saved token. */
async function logout(ctx: CommandContext, opts: { json?: true }): Promise<number> {
	const authed = authedApi(ctx);
	const saved = authed.success && authed.data.source === "saved";
	const revoked = saved ? (await authed.data.api.signOut()).success : false;
	const removed = clearCredentials(ctx.env);
	if (opts.json) {
		emit(ctx, true, { loggedOut: removed, revoked }, "");
		return 0;
	}
	if (!removed) note(ctx, "not logged in");
	else success(ctx, revoked ? "logged out" : "logged out (the server could not be reached to revoke the session)");
	return 0;
}

export const logoutCommand = defineCommand({
	name: "logout",
	group: "Account",
	summary: "log out of warden cloud and forget the saved token",
	register: (cmd, ctx, done) => {
		cmd.option("--json", "machine-readable output").action(async (opts) => done(await logout(ctx, opts)));
	},
});
