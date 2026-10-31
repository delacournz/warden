import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, note, reportError, success } from "../output";
import { createWardenApi } from "../remote/api";
import { type Credentials, readAccounts, removeAccount } from "../remote/credentials";
import { authContext } from "../remote/session";

type LogoutOpts = { account?: string; all?: true; json?: true };

/** Revoke one session server-side; best effort (offline still logs out). */
async function revoke(ctx: CommandContext, credentials: Credentials): Promise<boolean> {
	const api = createWardenApi({
		baseUrl: credentials.apiUrl,
		token: credentials.token,
		...(ctx.fetch ? { fetch: ctx.fetch } : {}),
	});
	return (await api.signOut()).success;
}

/** The accounts to log out of: `--all`, `--account <name>`, or the one this directory uses. */
function targets(ctx: CommandContext, opts: LogoutOpts): { names: string[]; error?: string } {
	const saved = readAccounts(ctx.env);
	if (!saved.success) return { names: [], error: saved.error };
	const accounts = saved.data?.accounts ?? {};
	if (opts.all) return { names: Object.keys(accounts).sort() };
	if (opts.account) return { names: accounts[opts.account] ? [opts.account] : [] };
	const auth = authContext(ctx);
	if (auth.success && auth.data.kind === "saved") return { names: [auth.data.account] };
	return { names: [] };
}

/** Revoke and forget `--account <name>`, every account (`--all`), or the account this directory resolves to. */
async function logout(ctx: CommandContext, opts: LogoutOpts): Promise<number> {
	if (opts.all && opts.account) {
		reportError(ctx, "logout", "pass --account or --all, not both");
		return 1;
	}
	const { names, error } = targets(ctx, opts);
	if (error) {
		reportError(ctx, "logout", error);
		return 1;
	}
	const saved = readAccounts(ctx.env);
	const accounts = saved.success ? (saved.data?.accounts ?? {}) : {};
	let revoked = names.length > 0;
	for (const name of names) {
		const credentials = accounts[name];
		if (credentials && !(await revoke(ctx, credentials))) revoked = false;
		const removed = removeAccount(ctx.env, name);
		if (!removed.success) {
			reportError(ctx, "logout", removed.error);
			return 1;
		}
	}
	const loggedOut = names.length > 0;
	if (opts.json) {
		emit(ctx, true, { loggedOut, revoked, accounts: names }, "");
		return 0;
	}
	if (!loggedOut) note(ctx, opts.account ? `no account ${opts.account}` : "not logged in");
	else {
		const which = names.length === 1 ? ` of ${names[0]}` : ` of ${names.join(", ")}`;
		success(
			ctx,
			revoked ? `logged out${which}` : `logged out${which} (the server could not be reached to revoke the session)`
		);
	}
	return 0;
}

export const logoutCommand = defineCommand({
	name: "logout",
	group: "Account",
	summary: "log out of warden cloud and forget the saved token",
	register: (cmd, ctx, done) => {
		cmd
			.option("--account <name>", "log out of this account (default: the one this directory uses)")
			.option("--all", "log out of every account")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await logout(ctx, opts)));
	},
});
