import { describe, expect, test } from "bun:test";
import { type AuthInput, resolveAuthContext } from "./context";
import type { Credentials } from "./credentials";
import type { Link } from "./links";

const API = "https://api.warden.co.nz";

function creds(email: string, organizationId?: string, apiUrl = API): Credentials {
	return {
		apiUrl,
		token: `tok-${email}`,
		user: { id: `u-${email}`, email },
		...(organizationId ? { organizationId } : {}),
		savedAt: 1,
	};
}

const accounts = {
	version: 2 as const,
	default: "default",
	accounts: { default: creds("me@a.co", "org-a"), work: creds("me@client.co", "org-w") },
};

const pathLink: Link = {
	kind: "path",
	path: "/ws/client",
	account: "work",
	organizationId: "org-client",
	orgSlug: "client",
	createdAt: 1,
};
const remoteLink: Link = {
	kind: "remote",
	remote: "github.com/acme/app",
	account: "default",
	organizationId: "org-acme",
	orgSlug: "acme",
	createdAt: 1,
};

function input(over: Partial<AuthInput> = {}): AuthInput {
	return { env: {}, accounts, links: [pathLink, remoteLink], cwd: "/elsewhere", ...over };
}

describe("resolveAuthContext", () => {
	test("WARDEN_TOKEN wins over everything, WARDEN_ORG rides along", () => {
		const r = resolveAuthContext(input({ env: { WARDEN_TOKEN: "t", WARDEN_ORG: "acme" }, cwd: "/ws/client" }));
		expect(r).toEqual({
			success: true,
			data: { kind: "env", apiUrl: API, token: "t", organization: "acme", orgVia: "env" },
		});
	});

	test("WARDEN_TOKEN honours a lease's org over WARDEN_ORG", () => {
		const r = resolveAuthContext(
			input({ env: { WARDEN_TOKEN: "t", WARDEN_ORG: "acme" }, pin: { organizationId: "org-lease" } })
		);
		expect(r.success && r.data).toMatchObject({ kind: "env", organization: "org-lease", orgVia: "lease" });
	});

	test("WARDEN_TOKEN without WARDEN_ORG sends no org", () => {
		const r = resolveAuthContext(input({ env: { WARDEN_TOKEN: "t" } }));
		expect(r.success && r.data.kind === "env" && r.data.orgVia).toBe("session");
		expect(r.success && r.data.kind === "env" && r.data.organization).toBeUndefined();
	});

	test("no link: default account and its saved org", () => {
		const r = resolveAuthContext(input());
		expect(r.success && r.data).toMatchObject({
			kind: "saved",
			account: "default",
			accountVia: "default",
			organization: "org-a",
			orgVia: "account",
		});
	});

	test("path link picks its account and org", () => {
		const r = resolveAuthContext(input({ cwd: "/ws/client/worktree-1/src" }));
		expect(r.success && r.data).toMatchObject({
			kind: "saved",
			account: "work",
			accountVia: "link",
			organization: "org-client",
			orgVia: "link",
			link: pathLink,
		});
	});

	test("remote link matches when no path link does", () => {
		const r = resolveAuthContext(input({ remote: "git@github.com:acme/app.git" }));
		expect(r.success && r.data).toMatchObject({ account: "default", organization: "org-acme", orgVia: "link" });
	});

	test("WARDEN_ACCOUNT beats the link's account; the link's org still applies", () => {
		const r = resolveAuthContext(input({ env: { WARDEN_ACCOUNT: "default" }, cwd: "/ws/client" }));
		expect(r.success && r.data).toMatchObject({
			account: "default",
			accountVia: "env",
			organization: "org-client",
			orgVia: "link",
		});
	});

	test("WARDEN_ORG beats the link's org", () => {
		const r = resolveAuthContext(input({ env: { WARDEN_ORG: "other" }, cwd: "/ws/client" }));
		expect(r.success && r.data).toMatchObject({ account: "work", organization: "other", orgVia: "env" });
	});

	test("a pin (from a lease) beats link and env", () => {
		const r = resolveAuthContext(
			input({
				env: { WARDEN_ACCOUNT: "default", WARDEN_ORG: "x" },
				cwd: "/ws/client",
				pin: { account: "work", organizationId: "org-lease" },
			})
		);
		expect(r.success && r.data).toMatchObject({
			account: "work",
			accountVia: "lease",
			organization: "org-lease",
			orgVia: "lease",
		});
	});

	test("an account with no saved org falls back to the session", () => {
		const r = resolveAuthContext(
			input({ accounts: { version: 2, default: "default", accounts: { default: creds("me@a.co") } } })
		);
		expect(r.success && r.data).toMatchObject({ kind: "saved", orgVia: "session" });
		expect(r.success && r.data.kind === "saved" && r.data.organization).toBeUndefined();
	});

	test("a link to a missing account is account_missing", () => {
		const r = resolveAuthContext(
			input({ accounts: { ...accounts, accounts: { default: creds("me@a.co") } }, cwd: "/ws/client" })
		);
		expect(r).toEqual({
			success: false,
			error: {
				code: "account_missing",
				message: "/ws/client is linked to account work; run warden login --account work",
			},
		});
	});

	test("WARDEN_ACCOUNT naming a missing account is account_missing", () => {
		const r = resolveAuthContext(input({ env: { WARDEN_ACCOUNT: "nope" } }));
		expect(!r.success && r.error.code).toBe("account_missing");
	});

	test("no accounts at all = none", () => {
		const r = resolveAuthContext(input({ accounts: undefined, links: [] }));
		expect(r).toEqual({ success: true, data: { kind: "none", apiUrl: API } });
	});

	test("WARDEN_API_URL pointing elsewhere never sends a token issued by another api", () => {
		const r = resolveAuthContext(input({ env: { WARDEN_API_URL: "https://staging.example/" } }));
		expect(r).toEqual({ success: true, data: { kind: "none", apiUrl: "https://staging.example" } });
	});
});
