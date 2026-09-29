import { DEFAULT_PROFILE } from "@warden/core/config.defaults";
import { ensureGolden, listGoldens, pruneGoldens } from "@warden/core/golden/ios-golden";
import { resolveOwner } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { goldenDeps, type Sleep } from "../golden-deps";
import { emit, formatTable } from "../output";
import { withSpinner } from "../spinner-context";

type EnsureOpts = { profile?: string; runtime?: string; json?: true };
type PruneOpts = { all?: true; yes?: true; json?: true };

async function ensure(ctx: CommandContext, sleep: Sleep | undefined, opts: EnsureOpts): Promise<number> {
	const { color } = ctx.ui;
	const profile = opts.profile ?? DEFAULT_PROFILE.ios;
	const golden = await withSpinner(ctx, `ensuring golden ${profile} image…`, async (sctx, spinner) => {
		const result = await ensureGolden(goldenDeps(sctx, resolveOwner(ctx), sleep), profile, opts.runtime);
		if (result.success) spinner.succeed(`golden ${result.data.name} ${result.data.built ? "built" : "reused"}`);
		else spinner.fail("golden image failed");
		return result;
	});
	if (!golden.success) return fail(ctx, golden.error);
	const { name, udid, built } = golden.data;
	emit(
		ctx,
		opts.json === true,
		golden.data,
		`${color.green(`${color.bold(name)} ${udid}`)} ${color.dim(`(${built ? "built" : "reused"})`)}`
	);
	return 0;
}

async function ls(ctx: CommandContext, sleep: Sleep | undefined, json: boolean): Promise<number> {
	const { color } = ctx.ui;
	const goldens = await listGoldens(goldenDeps(ctx, resolveOwner(ctx), sleep));
	if (!goldens.success) return fail(ctx, goldens.error);
	const table = formatTable(
		["NAME", "UDID", "STATE", "RUNTIME", "AVAILABLE"],
		goldens.data.map((g) => [
			g.name,
			g.udid,
			g.state === "Shutdown" ? color.dim(g.state) : color.yellow(g.state),
			g.runtimeId.split(".").pop() ?? "",
			g.isAvailable ? color.green("yes") : color.red("no"),
		]),
		color
	);
	emit(ctx, json, goldens.data, goldens.data.length > 0 ? table : color.dim("no golden images"));
	return 0;
}

/**
 * `--all` deletes every golden: asks first in a terminal (unless `--yes`); without a terminal
 * (or with `--json`, whose stdout must stay one document) it needs `--yes`.
 */
async function confirmPruneAll(ctx: CommandContext, sleep: Sleep | undefined, opts: PruneOpts): Promise<number> {
	if (opts.yes) return 0;
	const { ui } = ctx;
	if (!ui.interactive || opts.json) {
		ctx.err(ui.color.red("warden golden prune: --all deletes every golden image — pass --yes to confirm"));
		return 1;
	}
	const goldens = await listGoldens(goldenDeps(ctx, resolveOwner(ctx), sleep));
	if (!goldens.success) return fail(ctx, goldens.error);
	if (goldens.data.length === 0) return 0;
	const answer = await ui.confirm(`Delete all ${goldens.data.length} golden image(s)?`, false);
	if (answer === true) return 0;
	ui.cancelled("Aborted.");
	return 1;
}

async function prune(ctx: CommandContext, sleep: Sleep | undefined, opts: PruneOpts): Promise<number> {
	const { color } = ctx.ui;
	const all = opts.all === true;
	if (all) {
		const confirmed = await confirmPruneAll(ctx, sleep, opts);
		if (confirmed !== 0) return confirmed;
	}
	const pruned = await withSpinner(ctx, all ? "deleting golden images…" : "pruning stale golden images…", (sctx) =>
		pruneGoldens(goldenDeps(sctx, resolveOwner(ctx), sleep), { all })
	);
	if (!pruned.success) return fail(ctx, pruned.error);
	const text =
		pruned.data.length > 0
			? color.green(`deleted ${pruned.data.map((g) => g.name).join(" ")}`)
			: color.dim("nothing to prune");
	emit(ctx, opts.json === true, pruned.data, text);
	return 0;
}

function fail(ctx: CommandContext, error: string): number {
	ctx.err(ctx.ui.color.red(`warden golden: ${error}`));
	return 1;
}

/**
 * Golden iOS images: one first-booted, settled, shut-down sim per Xcode + runtime + device type.
 * `warden claim` clones new pool devices from it (seconds) instead of a fresh first boot (minutes).
 */
export function createGoldenCommand(opts: { sleep?: Sleep } = {}): Command {
	const { sleep } = opts;
	return defineCommand({
		name: "golden",
		summary: "golden iOS images new sims are cloned from (fast boots): ensure | ls | prune",
		register: (cmd, ctx, done) => {
			cmd
				.command("ensure")
				.description("build (once) or reuse the golden image")
				.option("--profile <slug>", `device profile (default: ${DEFAULT_PROFILE.ios})`)
				.option("--runtime <runtime>", "runtime: latest, iOS-26-5, 26.5 …")
				.option("--json", "machine-readable output")
				.action(async (o) => done(await ensure(ctx, sleep, o)));
			cmd
				.command("ls")
				.description("list golden images")
				.option("--json", "machine-readable output")
				.action(async (o) => done(await ls(ctx, sleep, o.json === true)));
			cmd
				.command("prune")
				.description("delete stale goldens (--all: every golden)")
				.option("--all", "delete every golden image, not just stale ones")
				.option("-y, --yes", "don't ask before --all deletes")
				.option("--json", "machine-readable output")
				.action(async (o) => done(await prune(ctx, sleep, o)));
		},
	});
}

export const goldenCommand: Command = createGoldenCommand();
