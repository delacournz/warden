import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, reportError } from "../output";
import type { Billing, RevylApproval } from "../remote/api.types";
import { minutesLeft, trialLine, usd } from "../remote/format";
import { authedApi } from "../remote/session";

/** The balance and trial lines; none when billing can't be read. */
function billingLines(ctx: CommandContext, account: Billing | null): string[] {
	if (!account) return [];
	const { color } = ctx.ui;
	const balance = account.lowBalance ? color.yellow(usd(account.balanceUsd)) : usd(account.balanceUsd);
	return [
		`balance       ${balance}${color.dim(`  ${minutesLeft(account)}`)}`,
		`trial         ${trialLine(account.trial)}`,
	];
}

/** The owner's Revyl connect code while the workspace awaits approval; none otherwise. */
function approvalLines(ctx: CommandContext, approval: RevylApproval | null): string[] {
	if (!approval) return [];
	const { color } = ctx.ui;
	return [`              ${color.yellow(`approve in Revyl with code ${approval.userCode}`)}  ${approval.uri}`];
}

/**
 * Who warden cloud says this token is, the active organization, whether remote devices are ready for it, and the
 * organization's prepaid balance (left out when billing can't be read).
 */
async function whoami(ctx: CommandContext, opts: { json?: true }): Promise<number> {
	const authed = authedApi(ctx);
	if (!authed.success) {
		reportError(ctx, "whoami", authed.error);
		return 1;
	}
	const [me, billing] = await Promise.all([authed.data.api.me(), authed.data.api.getBilling()]);
	if (!me.success) {
		const hint = me.error.kind === "unauthorized" ? " (session expired? run warden login)" : "";
		reportError(ctx, "whoami", `${me.error.message}${hint}`);
		return 1;
	}
	const { user, organization, remote } = me.data;
	const { color } = ctx.ui;
	const account = billing.success ? billing.data : null;
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
		...approvalLines(ctx, remote?.approval ?? null),
		...billingLines(ctx, account),
		color.dim(`api           ${authed.data.apiUrl}${authed.data.source === "env" ? " (WARDEN_TOKEN)" : ""}`),
	];
	emit(
		ctx,
		opts.json === true,
		{ apiUrl: authed.data.apiUrl, source: authed.data.source, ...me.data, billing: account },
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
	summary: "show the warden cloud account, organization, balance and remote-device status",
	register: (cmd, ctx, done) => {
		cmd.option("--json", "machine-readable output").action(async (opts) => done(await whoami(ctx, opts)));
	},
});
