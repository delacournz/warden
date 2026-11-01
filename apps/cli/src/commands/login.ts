import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, note, reportError, success, warn } from "../output";
import { createWardenApi, type WardenApi } from "../remote/api";
import type { Organization } from "../remote/api.types";
import { openBrowser } from "../remote/browser";
import {
	type Accounts,
	type Credentials,
	DEFAULT_ACCOUNT,
	DEFAULT_API_URL,
	isAccountName,
	readAccounts,
	writeAccount,
} from "../remote/credentials";
import { pollDeviceToken } from "../remote/device-login";
import { machineDepsFor, machineHash } from "../remote/machine";
import { anonApi } from "../remote/session";

type LoginOpts = { account?: string; apiUrl?: string; browser?: boolean; org?: string; json?: true };

/** `registered`, `none` (no machine id here, e.g. CI) or `failed` (the server refused or was unreachable). */
type MachineRegistration = "registered" | "none" | "failed";

/**
 * Record this machine's hashed id against the account, which is what unlocks the one-per-person free trial.
 * Never fatal: paid usage works without it.
 */
async function registerMachine(ctx: CommandContext, api: WardenApi): Promise<MachineRegistration> {
	const machine = await machineHash(machineDepsFor(ctx));
	if (machine.kind === "none") return "none";
	return (await api.registerMachine(machine.hash)).success ? "registered" : "failed";
}

/** The org the login's account is saved with: `--org`, the only one, the prompt, else the session's active org or the first. */
type OrgPick =
	| { kind: "picked"; org: Organization | undefined }
	| { kind: "failed"; message: string }
	| { kind: "cancelled" };

async function pickOrg(
	ctx: CommandContext,
	opts: LoginOpts,
	orgs: Organization[],
	active: Organization | null
): Promise<OrgPick> {
	if (opts.org !== undefined) {
		const org = orgs.find((o) => o.slug === opts.org || o.id === opts.org);
		if (org) return { kind: "picked", org };
		const known = orgs.length > 0 ? orgs.map((o) => o.slug).join(", ") : "none";
		return { kind: "failed", message: `not a member of ${opts.org} (your organizations: ${known})` };
	}
	const current = active ? orgs.find((o) => o.id === active.id) : undefined;
	if (orgs.length <= 1 || !ctx.ui.interactive || opts.json) {
		return { kind: "picked", org: current ?? orgs[0] ?? active ?? undefined };
	}
	const ordered = current ? [current, ...orgs.filter((o) => o !== current)] : orgs;
	const choice = await ctx.ui.select(
		"Default organization for this login?",
		ordered.map((o) => ({ value: o.slug, label: o.name, hint: o.slug }))
	);
	const org = orgs.find((o) => o.slug === choice);
	return org ? { kind: "picked", org } : { kind: "cancelled" };
}

type OrgResolution =
	| { kind: "resolved"; orgs: Organization[]; organization: Organization | undefined }
	| Exclude<OrgPick, { kind: "picked" }>;

/**
 * List the user's orgs, pick the login's one and make it the session's active org (a failure there only warns:
 * every request names its org anyway).
 */
async function resolveOrg(
	ctx: CommandContext,
	opts: LoginOpts,
	authed: WardenApi,
	active: Organization | null
): Promise<OrgResolution> {
	const listed = await authed.listOrganizations();
	if (!listed.success) warn(ctx, `could not list your organizations: ${listed.error.message}`);
	const orgs = listed.success ? listed.data : active ? [active] : [];
	const pick = await pickOrg(ctx, opts, orgs, active);
	if (pick.kind !== "picked") return pick;
	const organization = pick.org;
	if (organization && organization.id !== active?.id) {
		const set = await authed.setActiveOrganization(organization.id);
		if (!set.success) warn(ctx, `could not make ${organization.slug} the active organization: ${set.error.message}`);
	}
	return { kind: "resolved", orgs, organization };
}

type Profile = { account: string; organization: Organization };

/**
 * Save every other org as its own account named by its slug, sharing this login's session. An account of that
 * name for another user or warden-api is left alone (warned); the login's own account name is never reused.
 */
function saveProfiles(
	ctx: CommandContext,
	account: string,
	base: Credentials,
	others: Organization[],
	existing: Accounts | undefined
): Profile[] {
	const profiles: Profile[] = [];
	for (const org of others) {
		const name = org.slug;
		if (name === account) continue;
		if (!isAccountName(name)) {
			warn(ctx, `organization ${org.slug} has no profile (not a valid account name); use --org ${org.slug}`);
			continue;
		}
		const prior = existing?.accounts[name];
		if (prior && (prior.user.id !== base.user.id || prior.apiUrl !== base.apiUrl)) {
			warn(
				ctx,
				`account ${name} belongs to ${prior.user.email} (${prior.apiUrl}); kept it, no profile for ${org.slug}`
			);
			continue;
		}
		const saved = writeAccount(ctx.env, name, { ...base, organizationId: org.id });
		if (!saved.success) {
			warn(ctx, saved.error);
			continue;
		}
		profiles.push({ account: name, organization: org });
	}
	return profiles;
}

/**
 * Device-flow login: warden-api hands out a code, the user approves it in the browser, the CLI polls for the
 * session token and saves it as account `--account` (default `default`) in `$WARDEN_HOME/auth.json`; the first
 * account saved becomes the default. The account is saved with one organization (`--org`, the only one, a prompt
 * when there are several, else the session's active org or the first) and every other org is saved as a profile:
 * an account named by the org slug sharing the same session. The code and link go to stderr so `--json` stays data.
 */
async function login(ctx: CommandContext, opts: LoginOpts): Promise<number> {
	const account = opts.account ?? DEFAULT_ACCOUNT;
	if (!isAccountName(account)) {
		reportError(ctx, "login", `invalid account name ${account}: lowercase letters, digits and -, up to 32`);
		return 1;
	}
	const existing = readAccounts(ctx.env);
	if (!existing.success) {
		reportError(ctx, "login", existing.error);
		return 1;
	}
	const apiUrl = (opts.apiUrl ?? ctx.env.WARDEN_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
	const api = anonApi(ctx, apiUrl);
	const code = await api.deviceCode();
	if (!code.success) {
		reportError(ctx, "login", `${apiUrl}: ${code.error.message}`);
		return 1;
	}
	const link = code.data.verificationUriComplete ?? code.data.verificationUri;
	ctx.err(`Your code: ${ctx.ui.color.bold(code.data.userCode)}`);
	const opened = opts.browser !== false && ctx.ui.interactive && (await openBrowser(ctx, link));
	ctx.err(opened ? `Opened ${link}` : `Open ${link} to approve this login`);

	const token = await pollDeviceToken(api, code.data, {
		now: ctx.now,
		sleep: ctx.sleep ?? ((ms) => Bun.sleep(ms)),
	});
	if (!token.success) {
		reportError(ctx, "login", token.error);
		return 1;
	}
	const authed = createWardenApi({ baseUrl: apiUrl, token: token.data, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) });
	const me = await authed.me();
	if (!me.success) {
		reportError(ctx, "login", `logged in, but ${apiUrl}/v1/me failed: ${me.error.message}`);
		return 1;
	}
	const { user } = me.data;
	const resolved = await resolveOrg(ctx, opts, authed, me.data.organization);
	if (resolved.kind !== "resolved") {
		await authed.signOut();
		if (resolved.kind === "cancelled") ctx.ui.cancelled("Aborted.");
		else reportError(ctx, "login", resolved.message);
		return 1;
	}
	const { orgs, organization } = resolved;
	const base: Credentials = { apiUrl, token: token.data, user: { id: user.id, email: user.email }, savedAt: ctx.now() };
	const saved = writeAccount(ctx.env, account, {
		...base,
		...(organization ? { organizationId: organization.id } : {}),
	});
	if (!saved.success) {
		reportError(ctx, "login", saved.error);
		return 1;
	}
	const others = orgs.filter((o) => o.id !== organization?.id);
	const profiles = saveProfiles(ctx, account, base, others, existing.data);
	const machine = await registerMachine(ctx, authed);
	if (opts.json) {
		emit(ctx, true, { account, apiUrl, user, organization: organization ?? null, profiles, machine }, "");
		return 0;
	}
	success(ctx, `logged in as ${user.email}${account === DEFAULT_ACCOUNT ? "" : ` (account ${account})`}`);
	if (machine === "failed")
		warn(ctx, "could not register this machine; the free trial unlocks once it is (run warden login again)");
	if (organization) note(ctx, `organization: ${organization.name} (${organization.slug})`);
	else note(ctx, "no organization yet: create one in the browser, then warden login again");
	for (const p of profiles)
		note(ctx, `profile ${p.organization.slug} → --account ${p.account} (${p.organization.name})`);
	return 0;
}

export const loginCommand = defineCommand({
	name: "login",
	group: "Account",
	summary: "log in to warden cloud (remote simulators) in the browser",
	register: (cmd, ctx, done) => {
		cmd
			.option("--account <name>", `save this login as a named account (default: ${DEFAULT_ACCOUNT})`)
			.option("--api-url <url>", `warden-api to log in to (default: $WARDEN_API_URL or ${DEFAULT_API_URL})`)
			.option("--org <org>", "default organization for this login, slug or id (asks when you have several)")
			.option("--no-browser", "print the approval link instead of opening it")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await login(ctx, opts)));
	},
});
