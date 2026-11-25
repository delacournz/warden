import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { readGitFacts } from "@delacour/warden-core/git-facts";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, note, reportError, success, table } from "../output";
import type { Organization } from "../remote/api.types";
import { writeAccount } from "../remote/credentials";
import {
	type Link,
	type LinkTarget,
	matchLink,
	normalizeLinkPath,
	normalizeRemote,
	readLinks,
	removeLink,
	upsertLink,
} from "../remote/links";
import { createOrganization } from "../remote/org-create";
import { type Authed, authedApi } from "../remote/session";

type Opts = { json?: true; account?: string; path?: string; remote?: true; slug?: string };

const SCOPE = "org";

function pinFor(opts: Opts): { account: string } | undefined {
	return opts.account ? { account: opts.account } : undefined;
}

function realpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

function labelOf(target: LinkTarget): string {
	return target.kind === "path" ? target.path : target.remote;
}

/** `origin` of the checkout at `cwd`, normalised. */
async function originOf(ctx: CommandContext, cwd: string): Promise<string | undefined> {
	const res = await ctx.exec(["git", "remote", "get-url", "origin"], { cwd });
	return res.exitCode === 0 ? normalizeRemote(res.stdout) : undefined;
}

/** What `link` / `unlink` act on: `--remote` = this checkout's origin, else `--path`, else the git toplevel, else cwd. */
async function resolveTarget(ctx: CommandContext, opts: Opts): Promise<Result<LinkTarget>> {
	if (opts.remote && opts.path) return err("pass --path or --remote, not both");
	if (opts.remote) {
		const remote = await originOf(ctx, ctx.cwd);
		return remote ? ok({ kind: "remote", remote }) : err(`no git origin remote in ${ctx.cwd}`);
	}
	const base = opts.path
		? resolve(ctx.cwd, opts.path)
		: ((await readGitFacts(ctx.exec, ctx.cwd, ctx.git))?.toplevel ?? ctx.cwd);
	return ok({ kind: "path", path: normalizeLinkPath(realpath(base)) });
}

async function listOrgs(authed: Authed): Promise<Result<Organization[]>> {
	const orgs = await authed.api.listOrganizations();
	return orgs.success ? ok(orgs.data) : err(orgs.error.message);
}

async function list(ctx: CommandContext, opts: Opts): Promise<number> {
	const authed = authedApi(ctx, pinFor(opts));
	if (!authed.success) return fail(ctx, authed.error);
	const orgs = await listOrgs(authed.data);
	if (!orgs.success) return fail(ctx, orgs.error);
	const effective = authed.data.organization;
	const isActive = (o: Organization): boolean =>
		effective !== undefined && (o.id === effective || o.slug === effective);
	const rows = orgs.data.map((o) => [isActive(o) ? "*" : "", o.slug, o.name, o.id]);
	emit(
		ctx,
		opts.json === true,
		orgs.data.map((o) => ({ ...o, active: isActive(o) })),
		orgs.data.length === 0 ? "no organizations" : table(ctx, ["", "SLUG", "NAME", "ID"], rows),
		{ scope: SCOPE, detail: `${orgs.data.length}` }
	);
	return 0;
}

function fail(ctx: CommandContext, message: string): number {
	reportError(ctx, SCOPE, message);
	return 1;
}

/** Make `<slug|id>` the active organization server-side and remember it with the account's saved login. */
async function use(ctx: CommandContext, target: string, opts: Opts): Promise<number> {
	const authed = authedApi(ctx, pinFor(opts));
	if (!authed.success) return fail(ctx, authed.error);
	const orgs = await listOrgs(authed.data);
	if (!orgs.success) return fail(ctx, orgs.error);
	const org = orgs.data.find((o) => o.slug === target || o.id === target);
	if (!org) return fail(ctx, `no organization ${target} (warden org list)`);
	const set = await authed.data.api.setActiveOrganization(org.id);
	if (!set.success) return fail(ctx, set.error.message);
	if (authed.data.source === "saved") {
		const saved = writeAccount(ctx.env, authed.data.account, { ...authed.data.credentials, organizationId: org.id });
		if (!saved.success) return fail(ctx, saved.error);
	}
	if (opts.json) emit(ctx, true, org, "");
	else success(ctx, `using ${org.name} (${org.slug})`);
	return 0;
}

/**
 * `warden org create [name]`: create an organization (asks name + slug at a terminal). A saved account with no
 * organization yet takes it as its own; one that has one keeps it.
 */
async function create(ctx: CommandContext, name: string | undefined, opts: Opts): Promise<number> {
	const authed = authedApi(ctx, pinFor(opts));
	if (!authed.success) return fail(ctx, authed.error);
	const result = await createOrganization(ctx, authed.data.api, {
		...(name !== undefined ? { name } : {}),
		...(opts.slug !== undefined ? { slug: opts.slug } : {}),
	});
	if (result.kind === "cancelled") {
		ctx.ui.cancelled("Aborted.");
		return 1;
	}
	if (result.kind === "failed") return fail(ctx, result.message);
	const org = result.organization;
	const account = authed.data.source === "saved" ? authed.data.account : undefined;
	let saved = false;
	if (authed.data.source === "saved" && authed.data.credentials.organizationId === undefined) {
		const written = writeAccount(ctx.env, authed.data.account, { ...authed.data.credentials, organizationId: org.id });
		if (!written.success) return fail(ctx, written.error);
		saved = true;
	}
	if (opts.json) {
		emit(ctx, true, { organization: org, ...(account ? { account } : {}), saved }, "");
		return 0;
	}
	success(ctx, `created ${org.name} (${org.slug})${saved ? ` for account ${account}` : ""}`);
	if (account && !saved)
		note(ctx, `account ${account} still uses its organization; warden org use ${org.slug} to switch`);
	return 0;
}

/** `warden org link [org]`: bind a directory (or git remote) to an account + org. */
async function link(ctx: CommandContext, orgArg: string | undefined, opts: Opts): Promise<number> {
	const authed = authedApi(ctx, pinFor(opts));
	if (!authed.success) return fail(ctx, authed.error);
	if (authed.data.source !== "saved") return fail(ctx, "org link needs a saved account (warden login)");
	const account = authed.data.account;
	const orgs = await listOrgs(authed.data);
	if (!orgs.success) return fail(ctx, orgs.error);

	let wanted = orgArg;
	if (wanted === undefined) {
		if (!ctx.ui.interactive || opts.json) return fail(ctx, "pass an organization: warden org link <org>");
		const choice = await ctx.ui.select(
			"Link to which organization?",
			orgs.data.map((o) => ({ value: o.slug, label: o.name, hint: o.slug }))
		);
		if (choice === undefined) {
			ctx.ui.cancelled("Aborted.");
			return 1;
		}
		wanted = choice;
	}
	const org = orgs.data.find((o) => o.slug === wanted || o.id === wanted);
	if (!org) return fail(ctx, `not a member of ${wanted} (warden org list --account ${account})`);

	const target = await resolveTarget(ctx, opts);
	if (!target.success) return fail(ctx, target.error);
	const entry: Link = { ...target.data, account, organizationId: org.id, orgSlug: org.slug, createdAt: ctx.now() };
	const saved = upsertLink(ctx.env, entry);
	if (!saved.success) return fail(ctx, saved.error);
	if (opts.json) emit(ctx, true, entry, "");
	else success(ctx, `linked ${labelOf(entry)} → ${org.name} (${org.slug}) as ${account}`);
	return 0;
}

async function unlink(ctx: CommandContext, opts: Opts): Promise<number> {
	const target = await resolveTarget(ctx, opts);
	if (!target.success) return fail(ctx, target.error);
	const removed = removeLink(ctx.env, target.data);
	if (!removed.success) return fail(ctx, removed.error);
	if (!removed.data.removed) return fail(ctx, `no link for ${labelOf(target.data)} (warden org links)`);
	if (opts.json) emit(ctx, true, { removed: true, target: target.data }, "");
	else success(ctx, `unlinked ${labelOf(target.data)}`);
	return 0;
}

async function links(ctx: CommandContext, opts: Opts): Promise<number> {
	const all = readLinks(ctx.env);
	if (!all.success) return fail(ctx, all.error);
	const cwd = realpath(ctx.cwd);
	const remote = all.data.some((l) => l.kind === "remote") ? await originOf(ctx, cwd) : undefined;
	const active = matchLink(all.data, { cwd, ...(remote ? { remote } : {}) });
	const rows = all.data.map((l) => [l === active ? "*" : "", labelOf(l), l.orgSlug, l.account]);
	emit(
		ctx,
		opts.json === true,
		all.data.map((l) => ({ ...l, active: l === active })),
		all.data.length === 0 ? "no links (warden org link <org>)" : table(ctx, ["", "TARGET", "ORG", "ACCOUNT"], rows),
		{ scope: SCOPE, detail: `${all.data.length} links` }
	);
	return 0;
}

export const orgCommand = defineCommand({
	name: "org",
	group: "Account",
	summary: "list, create or switch warden cloud organizations, or link directories to one",
	register: (cmd, ctx, done) => {
		const accountHelp = "saved account (default: the one for this directory)";
		cmd
			.command("list", { isDefault: true })
			.description("list your organizations (the default)")
			.option("--account <name>", accountHelp)
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await list(ctx, opts)));
		cmd
			.command("use")
			.description("switch the active organization (remote devices are billed to it)")
			.argument("<org>", "organization slug or id")
			.option("--account <name>", accountHelp)
			.option("--json", "machine-readable output")
			.action(async (target, opts) => done(await use(ctx, target, opts)));
		cmd
			.command("create")
			.description("create an organization (asks name and slug when omitted at a terminal)")
			.argument("[name]", "organization name; the slug is made from it")
			.option("--slug <slug>", "slug instead of the one made from the name (must be free)")
			.option("--account <name>", accountHelp)
			.option("--json", "machine-readable output")
			.action(async (name, opts) => done(await create(ctx, name, opts)));
		cmd
			.command("link")
			.description("bill remote devices claimed in this directory (or repo remote) to an organization")
			.argument("[org]", "organization slug or id (asks when omitted)")
			.option("--account <name>", accountHelp)
			.option("--path <dir>", "directory to link (default: the git toplevel, else the current directory)")
			.option("--remote", "link this checkout's git origin instead of a directory")
			.option("--json", "machine-readable output")
			.action(async (org, opts) => done(await link(ctx, org, opts)));
		cmd
			.command("unlink")
			.description("remove the link for this directory (or repo remote)")
			.option("--path <dir>", "directory to unlink (default: the git toplevel, else the current directory)")
			.option("--remote", "unlink this checkout's git origin")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await unlink(ctx, opts)));
		cmd
			.command("links")
			.description("list directory and remote links; * marks the one governing this directory")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await links(ctx, opts)));
	},
});
