import { ok, type Result } from "@delacour/warden-types/result";
import { type Accounts, type Credentials, DEFAULT_API_URL } from "./credentials";
import { type Link, matchLink } from "./links";

type Env = Record<string, string | undefined>;

/** Account + org a lease was claimed under, so release / heartbeat / view reach it from any directory. */
export type AuthPin = { account?: string; organizationId?: string };

/** Where the account came from: a lease pin, `WARDEN_ACCOUNT`, a `warden org link`, or the default account. */
export type AccountVia = "lease" | "env" | "link" | "default";

/** Where the org came from; `session` = none sent, warden-api uses the session's active org. */
export type OrgVia = "lease" | "env" | "link" | "account" | "session";

/** How a command authenticates and which org it acts for (`organization` = id or slug sent as `X-Warden-Organization`). */
export type AuthContext =
	| { kind: "env"; apiUrl: string; token: string; organization?: string; orgVia: "lease" | "env" | "session" }
	| {
			kind: "saved";
			apiUrl: string;
			account: string;
			accountVia: AccountVia;
			credentials: Credentials;
			organization?: string;
			orgVia: OrgVia;
			link?: Link;
	  }
	| { kind: "none"; apiUrl: string };

export type AuthContextError = { code: "account_missing"; message: string };

export type AuthInput = {
	env: Env;
	accounts: Accounts | undefined;
	links: readonly Link[];
	/** realpath of the working directory */
	cwd: string;
	/** `origin` url of the checkout, when there is one */
	remote?: string;
	pin?: AuthPin;
};

function linkLabel(link: Link): string {
	return link.kind === "path" ? link.path : link.remote;
}

/**
 * Pure precedence: `WARDEN_TOKEN` > saved accounts. Account = lease pin > `WARDEN_ACCOUNT` > matching link >
 * default. Org = lease pin > `WARDEN_ORG` > matching link > the account's saved org > the session's active org.
 * A saved account is only used for the api it was issued by, so `WARDEN_API_URL` at staging never sends a prod token.
 */
export function resolveAuthContext(input: AuthInput): Result<AuthContext, AuthContextError> {
	const { env, accounts, pin } = input;
	const override = env.WARDEN_API_URL?.replace(/\/+$/, "") || undefined;
	const envOrg = env.WARDEN_ORG?.trim() || undefined;
	if (env.WARDEN_TOKEN) {
		const apiUrl = override ?? DEFAULT_API_URL;
		const token = env.WARDEN_TOKEN;
		if (pin?.organizationId) {
			return ok({ kind: "env", apiUrl, token, organization: pin.organizationId, orgVia: "lease" });
		}
		return ok(
			envOrg
				? { kind: "env", apiUrl, token, organization: envOrg, orgVia: "env" }
				: { kind: "env", apiUrl, token, orgVia: "session" }
		);
	}
	const none: AuthContext = { kind: "none", apiUrl: override ?? DEFAULT_API_URL };
	if (!accounts || Object.keys(accounts.accounts).length === 0) return ok(none);

	const link = matchLink(input.links, { cwd: input.cwd, ...(input.remote ? { remote: input.remote } : {}) });
	const envAccount = env.WARDEN_ACCOUNT?.trim() || undefined;
	const [account, accountVia]: [string, AccountVia] = pin?.account
		? [pin.account, "lease"]
		: envAccount
			? [envAccount, "env"]
			: link
				? [link.account, "link"]
				: [accounts.default, "default"];
	const credentials = accounts.accounts[account];
	if (!credentials) {
		const why =
			accountVia === "link" && link
				? `${linkLabel(link)} is linked to account ${account}`
				: accountVia === "lease"
					? `the lease was claimed with account ${account}`
					: accountVia === "env"
						? `WARDEN_ACCOUNT=${account} is not logged in`
						: `no account ${account}`;
		return {
			success: false,
			error: { code: "account_missing", message: `${why}; run warden login --account ${account}` },
		};
	}
	if (override !== undefined && override !== credentials.apiUrl) return ok(none);

	const [organization, orgVia]: [string | undefined, OrgVia] = pin?.organizationId
		? [pin.organizationId, "lease"]
		: envOrg
			? [envOrg, "env"]
			: link
				? [link.organizationId, "link"]
				: credentials.organizationId
					? [credentials.organizationId, "account"]
					: [undefined, "session"];
	return ok({
		kind: "saved",
		apiUrl: credentials.apiUrl,
		account,
		accountVia,
		credentials,
		...(organization ? { organization } : {}),
		orgVia,
		...(link ? { link } : {}),
	});
}
