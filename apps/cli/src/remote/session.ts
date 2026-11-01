import { realpathSync } from "node:fs";
import { bunGitSync } from "@delacour/warden-core/git-facts";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { createWardenApi, type WardenApi } from "./api";
import { type AccountVia, type AuthContext, type AuthPin, type OrgVia, resolveAuthContext } from "./context";
import { type Credentials, readAccounts } from "./credentials";
import { type Link, readLinks } from "./links";

/** A warden-api client that carries a token, where that token came from, and which org it acts for. */
export type Authed = {
	api: WardenApi;
	apiUrl: string;
	/** id or slug sent as `X-Warden-Organization`; unset = the session's active org */
	organization?: string;
	orgVia: OrgVia;
} & (
	| { source: "env" }
	| { source: "saved"; account: string; accountVia: AccountVia; credentials: Credentials; link?: Link }
);

export const NOT_LOGGED_IN = "not logged in; run warden login (or set WARDEN_TOKEN)";

/** A client with no token (login endpoints only). */
export function anonApi(ctx: CommandContext, apiUrl: string): WardenApi {
	return createWardenApi({ baseUrl: apiUrl, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) });
}

function realCwd(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return cwd;
	}
}

/** `origin` of the checkout at `cwd`; only asked for when a remote link exists. */
function originUrl(cwd: string): string | undefined {
	const r = bunGitSync(cwd, ["remote", "get-url", "origin"]);
	return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined;
}

/** Read the accounts + links on disk and resolve who this command runs as (see `resolveAuthContext`). */
export function authContext(ctx: CommandContext, pin?: AuthPin): Result<AuthContext> {
	const accounts = readAccounts(ctx.env);
	if (!accounts.success) return accounts;
	const links = readLinks(ctx.env);
	if (!links.success) return links;
	const cwd = realCwd(ctx.cwd);
	const remote = links.data.some((l) => l.kind === "remote") ? originUrl(cwd) : undefined;
	const resolved = resolveAuthContext({
		env: ctx.env,
		accounts: accounts.data,
		links: links.data,
		cwd,
		...(remote ? { remote } : {}),
		...(pin ? { pin } : {}),
	});
	return resolved.success ? resolved : { success: false, error: resolved.error.message };
}

/** The logged-in client for this command, or the message telling the user how to log in. */
export function authedApi(ctx: CommandContext, pin?: AuthPin): Result<Authed> {
	const auth = authContext(ctx, pin);
	if (!auth.success) return auth;
	const resolved = auth.data;
	const make = (token: string, organization?: string) =>
		createWardenApi({
			baseUrl: resolved.apiUrl,
			token,
			...(organization ? { organization } : {}),
			...(ctx.fetch ? { fetch: ctx.fetch } : {}),
		});
	switch (resolved.kind) {
		case "none":
			return { success: false, error: NOT_LOGGED_IN };
		case "env":
			return ok({
				api: make(resolved.token, resolved.organization),
				apiUrl: resolved.apiUrl,
				...(resolved.organization ? { organization: resolved.organization } : {}),
				orgVia: resolved.orgVia,
				source: "env",
			});
		case "saved":
			return ok({
				api: make(resolved.credentials.token, resolved.organization),
				apiUrl: resolved.apiUrl,
				...(resolved.organization ? { organization: resolved.organization } : {}),
				orgVia: resolved.orgVia,
				source: "saved",
				account: resolved.account,
				accountVia: resolved.accountVia,
				credentials: resolved.credentials,
				...(resolved.link ? { link: resolved.link } : {}),
			});
	}
}

/** The pin to stamp on a lease claimed with `authed`, so later calls for it reach the same account and org. */
export function pinOf(authed: Authed): AuthPin {
	return {
		...(authed.source === "saved" ? { account: authed.account } : {}),
		...(authed.organization ? { organizationId: authed.organization } : {}),
	};
}
