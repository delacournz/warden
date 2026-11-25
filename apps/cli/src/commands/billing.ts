import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, note, reportError, table } from "../output";
import type { LedgerEntry } from "../remote/api.types";
import { openBrowser } from "../remote/browser";
import { cloudFailure } from "../remote/errors";
import { minutesLeft, trialLine, usd } from "../remote/format";
import { authedApi } from "../remote/session";

type BillingOpts = { topUp?: string | true; limit?: string; browser?: boolean; json?: true };

const MIN_TOP_UP = 10;
const MAX_TOP_UP = 500;
const TOP_UP_CHOICES = ["10", "20", "50"] as const;
const DEFAULT_LIMIT = 10;

/** A top-up amount in USD: $10–$500, whole cents. */
export function parseTopUp(raw: string): number | undefined {
	if (!/^\d+(\.\d{1,2})?$/.test(raw.trim())) return undefined;
	const amount = Number(raw);
	return amount >= MIN_TOP_UP && amount <= MAX_TOP_UP ? amount : undefined;
}

/** The amount to top up: the flag's value, else a pick at a terminal, else an error naming the flag. */
async function topUpAmount(ctx: CommandContext, value: string | true): Promise<number | { error: string }> {
	if (value !== true) {
		return (
			parseTopUp(value) ?? { error: `top-up amount must be between $${MIN_TOP_UP} and $${MAX_TOP_UP} (got ${value})` }
		);
	}
	if (!ctx.ui.interactive) {
		return { error: `pass an amount: warden billing --top-up <amount> ($${MIN_TOP_UP}–$${MAX_TOP_UP})` };
	}
	const picked = await ctx.ui.select(
		"Top up how much? (any amount from $10 to $500: warden billing --top-up <amount>)",
		TOP_UP_CHOICES.map((v) => ({ value: v, label: `$${v}` }))
	);
	return picked === undefined ? { error: "cancelled" } : Number(picked);
}

/** Create a Stripe Checkout session for the active organization and open it; the balance updates once paid. */
async function topUp(ctx: CommandContext, value: string | true, opts: BillingOpts): Promise<number> {
	const authed = authedApi(ctx);
	if (!authed.success) {
		reportError(ctx, "billing", authed.error);
		return 1;
	}
	const amount = await topUpAmount(ctx, value);
	if (typeof amount !== "number") {
		reportError(ctx, "billing", amount.error);
		return 1;
	}
	const created = await authed.data.api.createTopup(amount);
	if (!created.success) {
		const { message, code } = cloudFailure(created.error);
		reportError(ctx, "billing", message, code ? { code } : undefined);
		return 1;
	}
	const { checkoutUrl } = created.data;
	const opened = opts.browser !== false && ctx.ui.interactive && (await openBrowser(ctx, checkoutUrl));
	if (!opts.json) note(ctx, `${opened ? "opened" : "pay at"} the ${usd(amount)} checkout; credit lands once paid`);
	emit(ctx, opts.json === true, { amountUsd: amount, checkoutUrl, opened }, checkoutUrl, {
		scope: "billing",
		detail: `top up ${usd(amount)}`,
	});
	return 0;
}

function ledgerTable(ctx: CommandContext, entries: readonly LedgerEntry[]): string {
	const { color } = ctx.ui;
	if (entries.length === 0) return color.dim("no ledger entries yet");
	return table(
		ctx,
		["WHEN", "KIND", "AMOUNT"],
		entries.map((e) => [
			e.createdAt.replace("T", " ").replace(/\.\d+Z$|Z$/, ""),
			e.kind,
			e.amountUsd < 0 ? usd(e.amountUsd) : color.green(`+${usd(e.amountUsd)}`),
		])
	);
}

/**
 * The active organization's prepaid warden cloud balance, minutes left at the per-minute rate, the free-trial state
 * and the newest ledger entries; `--top-up [amount]` buys more credit through Stripe Checkout.
 */
async function billing(ctx: CommandContext, opts: BillingOpts): Promise<number> {
	if (opts.topUp !== undefined) return topUp(ctx, opts.topUp, opts);
	const limit = opts.limit === undefined ? DEFAULT_LIMIT : Number(opts.limit);
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		reportError(ctx, "billing", `--limit must be 1..100 (got ${opts.limit})`);
		return 1;
	}
	const authed = authedApi(ctx);
	if (!authed.success) {
		reportError(ctx, "billing", authed.error);
		return 1;
	}
	const { api } = authed.data;
	const [summary, ledger] = await Promise.all([api.getBilling(), api.listLedger({ limit })]);
	if (!summary.success) {
		reportError(ctx, "billing", cloudFailure(summary.error).message);
		return 1;
	}
	const b = summary.data;
	const entries = ledger.success ? ledger.data.entries.slice(0, limit) : [];
	const { color } = ctx.ui;
	const text = [
		`balance  ${b.lowBalance ? color.yellow(usd(b.balanceUsd)) : color.bold(usd(b.balanceUsd))}${color.dim(`  ${minutesLeft(b)}`)}`,
		`trial    ${trialLine(b.trial)}`,
		`top up   ${b.billingUrl} ${color.dim("(or: warden billing --top-up <amount>)")}`,
		"",
		ledger.success ? ledgerTable(ctx, entries) : color.yellow(`ledger unavailable: ${ledger.error.message}`),
	].join("\n");
	emit(ctx, opts.json === true, { billing: b, ledger: entries }, text, {
		scope: "billing",
		detail: usd(b.balanceUsd),
	});
	return 0;
}

export const billingCommand = defineCommand({
	name: "billing",
	group: "Account",
	summary: "show the warden cloud balance and ledger, or top up credit",
	register: (cmd, ctx, done) => {
		cmd
			.option("--top-up [amount]", "buy credit in USD ($10–$500) through Stripe Checkout; no amount = pick one")
			.option("--limit <n>", `ledger entries to show (default ${DEFAULT_LIMIT})`)
			.option("--no-browser", "print the checkout link instead of opening it")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await billing(ctx, opts)));
	},
});
