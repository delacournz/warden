import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, reportError } from "../output";
import { authedApi } from "../remote/session";

/** Who warden cloud says this token is, the active organization, and whether remote devices are ready for it. */
async function whoami(ctx: CommandContext, opts: { json?: true }): Promise<number> {
	const authed = authedApi(ctx);
	if (!authed.success) {
		reportError(ctx, "whoami", authed.error);
		return 1;
	}
	const me = await authed.data.api.me();
	if (!me.success) {
		const hint = me.error.kind === "unauthorized" ? " (session expired? run warden login)" : "";
		reportError(ctx, "whoami", `${me.error.message}${hint}`);
		return 1;
	}
	const { user, organization, remote } = me.data;
	const { color } = ctx.ui;
	const lines = [
		`${user.email}${user.name ? color.dim(` (${user.name})`) : ""}`,
		`organization  ${organization ? `${organization.name} ${color.dim(organization.slug)}` : color.yellow("none")}`,
		`remote        ${
			remote
				? `${remote.state === "connected" ? color.green(remote.state) : color.yellow(remote.state)}${
						remote.concurrencyLimit !== undefined
							? color.dim(`  ${remote.active}/${remote.concurrencyLimit} devices`)
							: ""
					}`
				: color.dim("not set up")
		}`,
		color.dim(`api           ${authed.data.apiUrl}${authed.data.source === "env" ? " (WARDEN_TOKEN)" : ""}`),
	];
	emit(
		ctx,
		opts.json === true,
		{ apiUrl: authed.data.apiUrl, source: authed.data.source, ...me.data },
		lines.join("\n"),
		{
			scope: "whoami",
		}
	);
	return 0;
}

export const whoamiCommand = defineCommand({
	name: "whoami",
	group: "Account",
	summary: "show the warden cloud account, organization and remote-device status",
	register: (cmd, ctx, done) => {
		cmd.option("--json", "machine-readable output").action(async (opts) => done(await whoami(ctx, opts)));
	},
});
