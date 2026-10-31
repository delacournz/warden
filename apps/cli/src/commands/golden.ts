import { profileSlug } from "@delacour/warden-core/allocate";
import { biometricProfile, splitBiometricProfile } from "@delacour/warden-core/biometrics";
import { DEFAULT_PROFILE } from "@delacour/warden-core/config.defaults";
import {
	ensureAndroidSnapshot,
	listAndroidSnapshots,
	pruneAndroidSnapshots,
} from "@delacour/warden-core/golden/android-golden";
import { ensureGolden, listGoldens, pruneGoldens } from "@delacour/warden-core/golden/ios-golden";
import { listAvds } from "@delacour/warden-core/providers/android";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { resolveAutoProfile, resolveOwner } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { androidGoldenDeps, goldenDeps, type Sleep } from "../golden-deps";
import { emit, heading, plural, reportError, table } from "../output";
import { withSpinner } from "../spinner-context";

type PlatformOpt = { platform?: string };
type EnsureOpts = PlatformOpt & { profile?: string; runtime?: string; json?: true };
type PruneOpts = PlatformOpt & { all?: true; yes?: true; json?: true };

/** `--platform`: ios (default) or android; anything else is reported and exits 1. */
function platformOf(ctx: CommandContext, opts: PlatformOpt): "ios" | "android" | undefined {
	const platform = opts.platform ?? "ios";
	if (platform === "ios" || platform === "android") return platform;
	reportError(ctx, "golden", `--platform must be ios or android, not "${platform}"`);
	return undefined;
}

/** The snapshot target a profile names: its AVD (`auto` = the first AVD), plus `+bio` for a biometrics profile. */
async function avdFor(ctx: CommandContext, profile: string): AsyncResult<string> {
	const avds = await listAvds({ exec: ctx.exec, env: ctx.env });
	if (!avds.success) return avds;
	const { profile: base, biometrics } = splitBiometricProfile(profile);
	const slug = base === "auto" ? resolveAutoProfile(avds.data) : ok(base);
	if (!slug.success) return slug;
	const avd = avds.data.find((a) => profileSlug(a) === slug.data);
	return avd !== undefined ? ok(biometricProfile(avd, biometrics)) : err(`no AVD matches profile "${slug.data}"`);
}

async function ensureAndroid(ctx: CommandContext, sleep: Sleep | undefined, opts: EnsureOpts): Promise<number> {
	const { color } = ctx.ui;
	const profile = opts.profile ?? DEFAULT_PROFILE.android;
	if (!opts.json) heading(ctx, "golden ensure", `android ${profile}`);
	const avd = await avdFor(ctx, profile);
	if (!avd.success) return fail(ctx, avd.error);
	const snapshot = await withSpinner(ctx, `ensuring quick-boot snapshot of ${avd.data}…`, async (sctx, spinner) => {
		const result = await ensureAndroidSnapshot(androidGoldenDeps(sctx, resolveOwner(ctx), sleep), avd.data, {
			explicit: true,
		});
		if (result.success && result.data)
			spinner.succeed(`snapshot ${result.data.name} ${result.data.built ? "built" : "reused"}`);
		else spinner.fail("snapshot failed");
		return result;
	});
	if (!snapshot.success) return fail(ctx, snapshot.error);
	if (snapshot.data === undefined) {
		return fail(ctx, `no snapshot of ${avd.data}: set ANDROID_HOME, and stop its running emulators first`);
	}
	const { name, built } = snapshot.data;
	emit(
		ctx,
		opts.json === true,
		snapshot.data,
		`${color.green(`${color.bold(name)} ${avd.data}`)} ${color.dim(`(${built ? "built" : "reused"})`)}`
	);
	return 0;
}

async function lsAndroid(ctx: CommandContext, sleep: Sleep | undefined, json: boolean): Promise<number> {
	const { color } = ctx.ui;
	const snapshots = await listAndroidSnapshots(androidGoldenDeps(ctx, resolveOwner(ctx), sleep));
	if (!snapshots.success) return fail(ctx, snapshots.error);
	const text = table(
		ctx,
		["NAME", "AVD", "CURRENT"],
		snapshots.data.map((s) => [s.name, s.avd, s.current ? color.green("yes") : color.red("stale")]),
		[{ column: 0, min: 18 }]
	);
	emit(ctx, json, snapshots.data, snapshots.data.length > 0 ? text : color.dim("no warden snapshots"), {
		scope: "golden ls",
		detail: plural(snapshots.data.length, "android snapshot"),
	});
	return 0;
}

async function ensure(ctx: CommandContext, sleep: Sleep | undefined, opts: EnsureOpts): Promise<number> {
	const platform = platformOf(ctx, opts);
	if (platform === undefined) return 1;
	if (platform === "android") return ensureAndroid(ctx, sleep, opts);
	const { color } = ctx.ui;
	const profile = opts.profile ?? DEFAULT_PROFILE.ios;
	if (!opts.json) heading(ctx, "golden ensure", profile);
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

async function ls(ctx: CommandContext, sleep: Sleep | undefined, opts: PlatformOpt & { json?: true }): Promise<number> {
	const platform = platformOf(ctx, opts);
	if (platform === undefined) return 1;
	const json = opts.json === true;
	if (platform === "android") return lsAndroid(ctx, sleep, json);
	const { color } = ctx.ui;
	const goldens = await listGoldens(goldenDeps(ctx, resolveOwner(ctx), sleep));
	if (!goldens.success) return fail(ctx, goldens.error);
	const text = table(
		ctx,
		["NAME", "UDID", "STATE", "RUNTIME", "AVAILABLE"],
		goldens.data.map((g) => [
			g.name,
			g.udid,
			g.state === "Shutdown" ? color.dim(g.state) : color.yellow(g.state),
			g.runtimeId.split(".").pop() ?? "",
			g.isAvailable ? color.green("yes") : color.red("no"),
		]),
		[
			{ column: 0, min: 18 },
			{ column: 1, min: 9 },
		]
	);
	emit(ctx, json, goldens.data, goldens.data.length > 0 ? text : color.dim("no golden images"), {
		scope: "golden ls",
		detail: plural(goldens.data.length, "golden image"),
	});
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
		reportError(ctx, "golden prune", "--all deletes every golden image — pass --yes to confirm");
		return 1;
	}
	const goldens: Result<unknown[]> =
		opts.platform === "android"
			? await listAndroidSnapshots(androidGoldenDeps(ctx, resolveOwner(ctx), sleep))
			: await listGoldens(goldenDeps(ctx, resolveOwner(ctx), sleep));
	if (!goldens.success) return fail(ctx, goldens.error);
	if (goldens.data.length === 0) return 0;
	const answer = await ui.confirm(`Delete all ${goldens.data.length} golden image(s)?`, false);
	if (answer === true) return 0;
	ui.cancelled("Aborted.");
	return 1;
}

async function prune(ctx: CommandContext, sleep: Sleep | undefined, opts: PruneOpts): Promise<number> {
	const platform = platformOf(ctx, opts);
	if (platform === undefined) return 1;
	const { color } = ctx.ui;
	const all = opts.all === true;
	if (all) {
		const confirmed = await confirmPruneAll(ctx, sleep, opts);
		if (confirmed !== 0) return confirmed;
	}
	const pruned = await withSpinner(
		ctx,
		all ? "deleting golden images…" : "pruning stale golden images…",
		(sctx): AsyncResult<Array<{ name: string }>> =>
			platform === "android"
				? pruneAndroidSnapshots(androidGoldenDeps(sctx, resolveOwner(ctx), sleep), { all })
				: pruneGoldens(goldenDeps(sctx, resolveOwner(ctx), sleep), { all })
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
	reportError(ctx, "golden", error);
	return 1;
}

/**
 * Golden iOS images: one first-booted, settled, shut-down sim per Xcode + runtime + device type.
 * `warden claim` clones new pool devices from it (seconds) instead of a fresh first boot (minutes).
 * `--platform android`: warden's quick-boot snapshot per AVD, which claimed emulators launch from.
 */
export function createGoldenCommand(opts: { sleep?: Sleep } = {}): Command {
	const { sleep } = opts;
	return defineCommand({
		name: "golden",
		group: "Devices",
		summary: "golden iOS images / Android snapshots new devices start from (fast boots): ensure | ls | prune",
		register: (cmd, ctx, done) => {
			cmd
				.command("ensure")
				.description("build (once) or reuse the golden image")
				.option("--platform <platform>", "ios (default) or android")
				.option("--profile <slug>", `device profile (default: ${DEFAULT_PROFILE.ios}; android: first AVD)`)
				.option("--runtime <runtime>", "runtime: latest, iOS-26-5, 26.5 …")
				.option("--json", "machine-readable output")
				.action(async (o) => done(await ensure(ctx, sleep, o)));
			cmd
				.command("ls")
				.description("list golden images")
				.option("--platform <platform>", "ios (default) or android")
				.option("--json", "machine-readable output")
				.action(async (o) => done(await ls(ctx, sleep, o)));
			cmd
				.command("prune")
				.description("delete stale goldens (--all: every golden)")
				.option("--platform <platform>", "ios (default) or android")
				.option("--all", "delete every golden image, not just stale ones")
				.option("-y, --yes", "don't ask before --all deletes")
				.option("--json", "machine-readable output")
				.action(async (o) => done(await prune(ctx, sleep, o)));
		},
	});
}

export const goldenCommand: Command = createGoldenCommand();
