import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, note, reportError, success } from "../output";
import { createWardenApi } from "../remote/api";
import { type Credentials, readAccounts, removeAccount, sameSession } from "../remote/credentials";
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

/**
 * The distinct sessions to revoke when `names` go; one another remaining account shares is kept (`kept: true`).
 */
function sessionsToRevoke(
	accounts: Record<string, Credentials>,
	names: string[]
): { toRevoke: Credentials[]; kept: boolean } {
	const staying = Object.entries(accounts)
		.filter(([name]) => !names.includes(name))
		.map(([, c]) => c);
	const toRevoke: Credentials[] = [];
	let kept = false;
	for (const name of names) {
		const credentials = accounts[name];
		if (!credentials) continue;
		if (staying.some((c) => sameSession(c, credentials))) kept = true;
		else if (!toRevoke.some((c) => sameSession(c, credentials))) toRevoke.push(credentials);
	}
	return { toRevoke, kept };
}

function outcome(kept: boolean, revoked: boolean, tried: boolean): string {
	if (kept) return " (session kept: other accounts from the same login still use it)";
	return revoked || !tried ? "" : " (the server could not be reached to revoke the session)";
}

/**
 * Revoke and forget `--account <name>`, every account (`--all`), or the account this directory resolves to.
 * A session another remaining account shares (org profiles from one login) is kept, not revoked (`kept`).
 */
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
	const { toRevoke, kept } = sessionsToRevoke(saved.success ? (saved.data?.accounts ?? {}) : {}, names);
	let revoked = toRevoke.length > 0;
	for (const credentials of toRevoke) if (!(await revoke(ctx, credentials))) revoked = false;
	for (const name of names) {
		const removed = removeAccount(ctx.env, name);
		if (!removed.success) {
			reportError(ctx, "logout", removed.error);
			return 1;
		}
	}
	const loggedOut = names.length > 0;
	if (opts.json) {
		emit(ctx, true, { loggedOut, revoked, kept, accounts: names }, "");
		return 0;
	}
	if (!loggedOut) note(ctx, opts.account ? `no account ${opts.account}` : "not logged in");
	else {
		const which = names.length === 1 ? ` of ${names[0]}` : ` of ${names.join(", ")}`;
		success(ctx, `logged out${which}${outcome(kept, revoked, toRevoke.length > 0)}`);
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
