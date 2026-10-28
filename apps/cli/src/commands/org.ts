import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, reportError, success, table } from "../output";
import { writeCredentials } from "../remote/credentials";
import { authedApi } from "../remote/session";

async function list(ctx: CommandContext, opts: { json?: true }): Promise<number> {
	const authed = authedApi(ctx);
	if (!authed.success) {
		reportError(ctx, "org", authed.error);
		return 1;
	}
	const orgs = await authed.data.api.listOrganizations();
	if (!orgs.success) {
		reportError(ctx, "org", orgs.error.message);
		return 1;
	}
	const active = authed.data.source === "saved" ? authed.data.credentials.organizationId : undefined;
	const rows = orgs.data.map((o) => [o.id === active ? "*" : "", o.slug, o.name, o.id]);
	emit(
		ctx,
		opts.json === true,
		orgs.data.map((o) => ({ ...o, active: o.id === active })),
		orgs.data.length === 0 ? "no organizations" : table(ctx, ["", "SLUG", "NAME", "ID"], rows),
		{ scope: "org", detail: `${orgs.data.length}` }
	);
	return 0;
}

/** Make `<slug|id>` the active organization server-side and remember it with the saved login. */
async function use(ctx: CommandContext, target: string, opts: { json?: true }): Promise<number> {
	const authed = authedApi(ctx);
	if (!authed.success) {
		reportError(ctx, "org", authed.error);
		return 1;
	}
	const orgs = await authed.data.api.listOrganizations();
	if (!orgs.success) {
		reportError(ctx, "org", orgs.error.message);
		return 1;
	}
	const org = orgs.data.find((o) => o.slug === target || o.id === target);
	if (!org) {
		reportError(ctx, "org", `no organization ${target} (warden org list)`);
		return 1;
	}
	const set = await authed.data.api.setActiveOrganization(org.id);
	if (!set.success) {
		reportError(ctx, "org", set.error.message);
		return 1;
	}
	if (authed.data.source === "saved") {
		const saved = writeCredentials(ctx.env, { ...authed.data.credentials, organizationId: org.id });
		if (!saved.success) {
			reportError(ctx, "org", saved.error);
			return 1;
		}
	}
	if (opts.json) emit(ctx, true, org, "");
	else success(ctx, `using ${org.name} (${org.slug})`);
	return 0;
}

export const orgCommand = defineCommand({
	name: "org",
	group: "Account",
	summary: "list warden cloud organizations or switch the active one",
	register: (cmd, ctx, done) => {
		cmd
			.command("list", { isDefault: true })
			.description("list your organizations (the default)")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await list(ctx, opts)));
		cmd
			.command("use")
			.description("switch the active organization (remote devices are billed to it)")
			.argument("<org>", "organization slug or id")
			.option("--json", "machine-readable output")
			.action(async (target, opts) => done(await use(ctx, target, opts)));
	},
});
