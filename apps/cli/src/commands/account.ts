import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, reportError, success, table } from "../output";
import { readAccounts, setDefaultAccount } from "../remote/credentials";
import { readLinks } from "../remote/links";
import { authContext } from "../remote/session";
import { logoutCommand } from "./logout";

/** Every saved account: `*` = the default, `>` = the one this directory uses (link, `WARDEN_ACCOUNT` or default). */
async function list(ctx: CommandContext, opts: { json?: true }): Promise<number> {
	const saved = readAccounts(ctx.env);
	if (!saved.success) {
		reportError(ctx, "account", saved.error);
		return 1;
	}
	const links = readLinks(ctx.env);
	const auth = authContext(ctx);
	const active = auth.success && auth.data.kind === "saved" ? auth.data.account : undefined;
	const accounts = saved.data;
	const rows = Object.entries(accounts?.accounts ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, c]) => ({
			name,
			default: name === accounts?.default,
			active: name === active,
			email: c.user.email,
			apiUrl: c.apiUrl,
			...(c.organizationId ? { organizationId: c.organizationId } : {}),
			links: links.success ? links.data.filter((l) => l.account === name).length : 0,
		}));
	emit(
		ctx,
		opts.json === true,
		rows,
		rows.length === 0
			? "no accounts; run warden login"
			: table(
					ctx,
					["", "NAME", "EMAIL", "LINKS", "API"],
					rows.map((r) => [`${r.default ? "*" : ""}${r.active ? ">" : ""}`, r.name, r.email, String(r.links), r.apiUrl])
				),
		{ scope: "account", detail: `${rows.length}` }
	);
	return 0;
}

async function setDefault(ctx: CommandContext, name: string, opts: { json?: true }): Promise<number> {
	const set = setDefaultAccount(ctx.env, name);
	if (!set.success) {
		reportError(ctx, "account", set.error);
		return 1;
	}
	if (opts.json) emit(ctx, true, { default: name }, "");
	else success(ctx, `default account: ${name}`);
	return 0;
}

export const accountCommand = defineCommand({
	name: "account",
	group: "Account",
	summary: "list warden cloud accounts, pick the default, or remove one",
	register: (cmd, ctx, done) => {
		cmd
			.command("list", { isDefault: true })
			.description("list saved accounts (the default)")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await list(ctx, opts)));
		cmd
			.command("default")
			.description("make an account the default (used where no link or WARDEN_ACCOUNT applies)")
			.argument("<name>", "account name")
			.option("--json", "machine-readable output")
			.action(async (name, opts) => done(await setDefault(ctx, name, opts)));
		cmd
			.command("rm")
			.description("log out of an account and forget it (= warden logout --account <name>)")
			.argument("<name>", "account name")
			.option("--json", "machine-readable output")
			.action(async (name, opts) =>
				done(await logoutCommand.run({ ...ctx, argv: ["--account", name, ...(opts.json ? ["--json"] : [])] }))
			);
	},
});
