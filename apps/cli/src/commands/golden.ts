import { DEFAULT_PROFILE } from "@delacour/warden-config/config.defaults";
import { AndroidGolden } from "@delacour/warden-core/golden/android-golden";
import { IosGolden } from "@delacour/warden-core/golden/ios-golden";
import { hostDeps, type Sleep } from "@delacour/warden-core/host-deps";
import { claimRequestRules } from "@delacour/warden-leasing/claim-request";
import { ownerResolver } from "@delacour/warden-leasing/owner";
import { Adb } from "@delacour/warden-providers/android";
import { biometricProfiles } from "@delacour/warden-providers/biometrics";
import { leaseModel } from "@delacour/warden-store/types";
import { wardenErrors } from "@delacour/warden-types/error";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { CliCommand, type CommandNode } from "../command";
import { type CommandContext, contextBuilder } from "../context";
import { output } from "../output";
import { withSpinner } from "../spinner-context";

type PlatformOpt = { platform?: string };
type EnsureOpts = PlatformOpt & { profile?: string; runtime?: string; json?: true };
type PruneOpts = PlatformOpt & { all?: true; yes?: true; json?: true };

export class GoldenCommand extends CliCommand {
	override readonly name = "golden";
	override readonly group = "Devices";
	override readonly summary =
		"golden iOS images / Android snapshots new devices start from (fast boots): ensure | ls | prune";

	constructor(private readonly opts: { sleep?: Sleep } = {}) {
		super();
	}

	/** `--platform`: ios (default) or android; anything else is reported and exits 1. */
	private platformOf(ctx: CommandContext, opts: PlatformOpt): "ios" | "android" | undefined {
		const platform = opts.platform ?? "ios";
		if (platform === "ios" || platform === "android") return platform;
		output.reportError(ctx, "golden", `--platform must be ios or android, not "${platform}"`);
		return undefined;
	}

	/** The snapshot target a profile names: its AVD (`auto` = the first AVD), plus `+bio` for a biometrics profile. */
	private async avdFor(ctx: CommandContext, profile: string): AsyncResult<string> {
		const avds = await new Adb({ exec: ctx.exec, env: ctx.env }).listAvds();
		if (!avds.success) return wardenErrors.toText(avds);
		const { profile: base, biometrics } = biometricProfiles.split(profile);
		const slug =
			base === "auto" ? wardenErrors.toText(claimRequestRules.resolveAutoProfile(avds.data)) : resultFactory.ok(base);
		if (!slug.success) return slug;
		const avd = avds.data.find((a) => leaseModel.profileSlug(a) === slug.data);
		return avd !== undefined
			? resultFactory.ok(biometricProfiles.profile(avd, biometrics))
			: resultFactory.err(`no AVD matches profile "${slug.data}"`);
	}

	private async ensureAndroid(ctx: CommandContext, sleep: Sleep | undefined, opts: EnsureOpts): Promise<number> {
		const { color } = ctx.ui;
		const profile = opts.profile ?? DEFAULT_PROFILE.android;
		if (!opts.json) output.heading(ctx, "golden ensure", `android ${profile}`);
		const avd = await this.avdFor(ctx, profile);
		if (!avd.success) return this.fail(ctx, avd.error);
		const snapshot = await withSpinner(ctx, `ensuring quick-boot snapshot of ${avd.data}…`, async (sctx, spinner) => {
			const result = await new AndroidGolden(
				hostDeps.androidGoldenDeps(contextBuilder.appHostFromContext(sctx), ownerResolver.resolve(ctx), sleep)
			).ensure(avd.data, {
				explicit: true,
			});
			if (result.success && result.data)
				spinner.succeed(`snapshot ${result.data.name} ${result.data.built ? "built" : "reused"}`);
			else spinner.fail("snapshot failed");
			return result;
		});
		if (!snapshot.success) return this.fail(ctx, snapshot.error);
		if (snapshot.data === undefined) {
			return this.fail(ctx, `no snapshot of ${avd.data}: set ANDROID_HOME, and stop its running emulators first`);
		}
		const { name, built } = snapshot.data;
		output.emit(
			ctx,
			opts.json === true,
			snapshot.data,
			`${color.green(`${color.bold(name)} ${avd.data}`)} ${color.dim(`(${built ? "built" : "reused"})`)}`
		);
		return 0;
	}

	private async lsAndroid(ctx: CommandContext, sleep: Sleep | undefined, json: boolean): Promise<number> {
		const { color } = ctx.ui;
		const snapshots = await new AndroidGolden(
			hostDeps.androidGoldenDeps(contextBuilder.appHostFromContext(ctx), ownerResolver.resolve(ctx), sleep)
		).list();
		if (!snapshots.success) return this.fail(ctx, snapshots.error);
		const text = output.table(
			ctx,
			["NAME", "AVD", "CURRENT"],
			snapshots.data.map((s) => [s.name, s.avd, s.current ? color.green("yes") : color.red("stale")]),
			[{ column: 0, min: 18 }]
		);
		output.emit(ctx, json, snapshots.data, snapshots.data.length > 0 ? text : color.dim("no warden snapshots"), {
			scope: "golden ls",
			detail: output.plural(snapshots.data.length, "android snapshot"),
		});
		return 0;
	}

	private async ensure(ctx: CommandContext, sleep: Sleep | undefined, opts: EnsureOpts): Promise<number> {
		const platform = this.platformOf(ctx, opts);
		if (platform === undefined) return 1;
		if (platform === "android") return this.ensureAndroid(ctx, sleep, opts);
		const { color } = ctx.ui;
		const profile = opts.profile ?? DEFAULT_PROFILE.ios;
		if (!opts.json) output.heading(ctx, "golden ensure", profile);
		const golden = await withSpinner(ctx, `ensuring golden ${profile} image…`, async (sctx, spinner) => {
			const result = await new IosGolden(
				hostDeps.goldenDeps(contextBuilder.appHostFromContext(sctx), ownerResolver.resolve(ctx), sleep)
			).ensure(profile, opts.runtime);
			if (result.success) spinner.succeed(`golden ${result.data.name} ${result.data.built ? "built" : "reused"}`);
			else spinner.fail("golden image failed");
			return result;
		});
		if (!golden.success) return this.fail(ctx, golden.error);
		const { name, udid, built } = golden.data;
		output.emit(
			ctx,
			opts.json === true,
			golden.data,
			`${color.green(`${color.bold(name)} ${udid}`)} ${color.dim(`(${built ? "built" : "reused"})`)}`
		);
		return 0;
	}

	private async ls(
		ctx: CommandContext,
		sleep: Sleep | undefined,
		opts: PlatformOpt & { json?: true }
	): Promise<number> {
		const platform = this.platformOf(ctx, opts);
		if (platform === undefined) return 1;
		const json = opts.json === true;
		if (platform === "android") return this.lsAndroid(ctx, sleep, json);
		const { color } = ctx.ui;
		const goldens = await new IosGolden(
			hostDeps.goldenDeps(contextBuilder.appHostFromContext(ctx), ownerResolver.resolve(ctx), sleep)
		).list();
		if (!goldens.success) return this.fail(ctx, goldens.error);
		const text = output.table(
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
		output.emit(ctx, json, goldens.data, goldens.data.length > 0 ? text : color.dim("no golden images"), {
			scope: "golden ls",
			detail: output.plural(goldens.data.length, "golden image"),
		});
		return 0;
	}

	/**
	 * `--all` deletes every golden: asks first in a terminal (unless `--yes`); without a terminal
	 * (or with `--json`, whose stdout must stay one document) it needs `--yes`.
	 */
	private async confirmPruneAll(ctx: CommandContext, sleep: Sleep | undefined, opts: PruneOpts): Promise<number> {
		if (opts.yes) return 0;
		const { ui } = ctx;
		if (!ui.interactive || opts.json) {
			output.reportError(ctx, "golden prune", "--all deletes every golden image — pass --yes to confirm");
			return 1;
		}
		const goldens: Result<unknown[]> =
			opts.platform === "android"
				? await new AndroidGolden(
						hostDeps.androidGoldenDeps(contextBuilder.appHostFromContext(ctx), ownerResolver.resolve(ctx), sleep)
					).list()
				: await new IosGolden(
						hostDeps.goldenDeps(contextBuilder.appHostFromContext(ctx), ownerResolver.resolve(ctx), sleep)
					).list();
		if (!goldens.success) return this.fail(ctx, goldens.error);
		if (goldens.data.length === 0) return 0;
		const answer = await ui.confirm(`Delete all ${goldens.data.length} golden image(s)?`, false);
		if (answer === true) return 0;
		ui.cancelled("Aborted.");
		return 1;
	}

	private async prune(ctx: CommandContext, sleep: Sleep | undefined, opts: PruneOpts): Promise<number> {
		const platform = this.platformOf(ctx, opts);
		if (platform === undefined) return 1;
		const { color } = ctx.ui;
		const all = opts.all === true;
		if (all) {
			const confirmed = await this.confirmPruneAll(ctx, sleep, opts);
			if (confirmed !== 0) return confirmed;
		}
		const pruned = await withSpinner(
			ctx,
			all ? "deleting golden images…" : "pruning stale golden images…",
			(sctx): AsyncResult<Array<{ name: string }>> =>
				platform === "android"
					? new AndroidGolden(
							hostDeps.androidGoldenDeps(contextBuilder.appHostFromContext(sctx), ownerResolver.resolve(ctx), sleep)
						).prune({ all })
					: new IosGolden(
							hostDeps.goldenDeps(contextBuilder.appHostFromContext(sctx), ownerResolver.resolve(ctx), sleep)
						).prune({ all })
		);
		if (!pruned.success) return this.fail(ctx, pruned.error);
		const text =
			pruned.data.length > 0
				? color.green(`deleted ${pruned.data.map((g) => g.name).join(" ")}`)
				: color.dim("nothing to prune");
		output.emit(ctx, opts.json === true, pruned.data, text);
		return 0;
	}

	private fail(ctx: CommandContext, error: string): number {
		output.reportError(ctx, "golden", error);
		return 1;
	}

	/**
	 * Golden iOS images: one first-booted, settled, shut-down sim per Xcode + runtime + device type.
	 * `warden claim` clones new pool devices from it (seconds) instead of a fresh first boot (minutes).
	 * `--platform android`: warden's quick-boot snapshot per AVD, which claimed emulators launch from.
	 */
	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd
			.command("ensure")
			.description("build (once) or reuse the golden image")
			.option("--platform <platform>", "ios (default) or android")
			.option("--profile <slug>", `device profile (default: ${DEFAULT_PROFILE.ios}; android: first AVD)`)
			.option("--runtime <runtime>", "runtime: latest, iOS-26-5, 26.5 …")
			.option("--json", "machine-readable output")
			.action(async (o) => done(await this.ensure(ctx, this.opts.sleep, o)));
		cmd
			.command("ls")
			.description("list golden images")
			.option("--platform <platform>", "ios (default) or android")
			.option("--json", "machine-readable output")
			.action(async (o) => done(await this.ls(ctx, this.opts.sleep, o)));
		cmd
			.command("prune")
			.description("delete stale goldens (--all: every golden)")
			.option("--platform <platform>", "ios (default) or android")
			.option("--all", "delete every golden image, not just stale ones")
			.option("-y, --yes", "don't ask before --all deletes")
			.option("--json", "machine-readable output")
			.action(async (o) => done(await this.prune(ctx, this.opts.sleep, o)));
	}
}

export const goldenCommand = new GoldenCommand().definition();
