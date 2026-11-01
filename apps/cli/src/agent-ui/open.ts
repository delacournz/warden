import type { BuildKind } from "@delacour/warden-config/build-kinds";
import { ownerResolver } from "@delacour/warden-leasing/owner";
import { type OpenParams, openOps } from "@delacour/warden-sdk/ops/open";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { leaseHostBuilder } from "../lease-host";
import { type ActionOptionValues, uiArgs } from "./args";
import { type UiDevice, uiDeviceResolver } from "./device";
import type { UiDeps } from "./driver";
import { uiOutput } from "./output";
import { uiRun } from "./run";
import { uiSession } from "./session";

export type OpenOptionValues = ActionOptionValues & {
	relaunch?: true;
	/** Metro URL: launch the dev client with `--initialUrl <url>` (iOS: and the dev-client args) and remember it */
	metro?: string;
	/** extra launch arguments */
	args?: string[];
	/** `--kind`: install this build kind on the device first (`simulator` = this worktree's repacked JS), launch without Metro */
	kind?: BuildKind;
	/** `--project`: the app's project dir for `--kind` (default: cwd) */
	project?: string;
};

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** What `--kind` put on the device: the build kind, its repack key and whether the device already ran it. */
type KindInstall = { kind: BuildKind; jsKey?: string; fresh: boolean; fallbackReason?: string };

type OpenData = Extract<Awaited<ReturnType<typeof openOps.open>>, { success: true }>["data"];

export class UiOpen {
	/** Whether any flag that only a bundle-id launch understands is set. */
	private hasLaunchOptions(opts: OpenOptionValues): boolean {
		return (
			opts.metro !== undefined ||
			opts.relaunch === true ||
			(opts.args?.length ?? 0) > 0 ||
			opts.kind !== undefined ||
			opts.project !== undefined
		);
	}

	/** `--kind`: make sure the kind's build is on the device (cached → repacked → built, then installed). */
	private async installKind(
		ctx: CommandContext,
		deps: UiDeps,
		device: UiDevice,
		opts: OpenOptionValues,
		kind: BuildKind
	): Promise<Result<KindInstall, WardenError>> {
		const ensure =
			deps.ensureApp ??
			(async (...args: Parameters<NonNullable<UiDeps["ensureApp"]>>) => {
				const { AppPreparer, defaultAppDeps } = await import("@delacour/warden-builds/prepare");
				return new AppPreparer(args[0], defaultAppDeps).ensureFor(args[1], args[2], args[3], args[4]);
			});
		const done = await ensure(
			leaseHostBuilder.leaseHostFromContext(ctx),
			ownerResolver.resolve(ctx),
			device.platform,
			device.udid,
			{
				eas: true,
				build: true,
				kind,
				...(opts.project !== undefined ? { project: opts.project } : {}),
			}
		);
		if (!done.success)
			return { success: false, error: uiOutput.uiError("failed", `--kind ${kind}: ${done.error.message}`) };
		const app = "kindApp" in done.data ? done.data.kindApp : undefined;
		return resultFactory.ok({
			kind: app?.kind ?? kind,
			fresh: done.data.source !== "installed",
			...(app?.kind === "simulator" ? { jsKey: app.repack.jsKey } : {}),
			...(app?.kind !== "simulator" && app?.fallbackReason !== undefined ? { fallbackReason: app.fallbackReason } : {}),
		});
	}

	/** `--kind`, when given: refuse `--metro` on a build with no dev client, then install the kind. */
	private async installRequestedKind(
		ctx: CommandContext,
		deps: UiDeps,
		device: UiDevice,
		opts: OpenOptionValues
	): Promise<Result<KindInstall | undefined, WardenError>> {
		const { kind, metro } = opts;
		if (kind === undefined) return resultFactory.ok(undefined);
		if (metro !== undefined && kind !== "dev") {
			return {
				success: false,
				error: uiOutput.uiError("usage", `--metro needs the dev client: --kind ${kind} runs without Metro`),
			};
		}
		return this.installKind(ctx, deps, device, opts, kind);
	}

	/** The build the launch ran, as a suffix of the op's summary line. */
	private buildNote(installed: KindInstall): string {
		const key = installed.jsKey ? ` ${installed.jsKey.slice(0, 12)}` : "";
		const fallback = installed.fallbackReason ? `, repack fallback: ${installed.fallbackReason}` : "";
		return ` (${installed.kind} build${key}${fallback})`;
	}

	/** The op's params from the flags: only what was given is passed. */
	private openParams(
		target: string,
		opts: OpenOptionValues,
		device: UiDevice,
		relaunch: boolean,
		settleMs: number | undefined
	): OpenParams {
		const args = opts.args ?? [];
		return {
			target,
			relaunch,
			...(opts.metro !== undefined ? { metro: opts.metro } : {}),
			...(args.length > 0 ? { args } : {}),
			...(settleMs !== undefined ? { settleMs } : {}),
			...(device.action === "attached" ? { note: uiDeviceResolver.sharedNote(device.lease) } : {}),
		};
	}

	/** `open <url>` with flags only a bundle-id launch understands. */
	private urlWithLaunchOptions(): Result<never, WardenError> {
		return {
			success: false,
			error: uiOutput.uiError(
				"usage",
				"--metro, --relaunch, --args, --kind and --project apply to a bundle id, not a URL",
				{
					hint: "open the bundle id first, then the URL",
				}
			),
		};
	}

	/** The open's success annotated with the build kind it installed first. */
	private withKind(opened: OpenData, installed: KindInstall): OpenData {
		const [first = "", ...rest] = opened.text.split("\n");
		return {
			...opened,
			text: [`${first}${this.buildNote(installed)}`, ...rest].join("\n"),
			result: {
				...opened.result,
				kind: installed.kind,
				...(installed.jsKey ? { jsKey: installed.jsKey } : {}),
				...(installed.fallbackReason !== undefined ? { fallbackReason: installed.fallbackReason } : {}),
			},
		};
	}

	/**
	 * `warden ui open <bundleId|url> [--relaunch] [--metro <url>] [--args …] [--kind <kind>]`. A bundle id launches the
	 * app (`--relaunch` terminates it first; `--metro` starts the dev client on that Metro with `--initialUrl`; `--kind`
	 * installs that build kind first). A URL is opened through the system; on iOS the "Open in …?" sheet is accepted.
	 * The app and Metro URL are remembered in `state.json` (`close --app` terminates that app).
	 */
	uiOpen(ctx: CommandContext, deps: UiDeps, what: string, opts: OpenOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "open", opts, async (device, env) => {
			const settle = uiArgs.parseSettle(opts.settle);
			if (!settle.success) return settle;
			const isUrl = URL_SCHEME.test(what);
			if (isUrl && this.hasLaunchOptions(opts)) return this.urlWithLaunchOptions();
			const kinded = isUrl ? resultFactory.ok(undefined) : await this.installRequestedKind(ctx, deps, device, opts);
			if (!kinded.success) return kinded;
			const installed = kinded.data;
			const relaunch = opts.relaunch === true || installed?.fresh === true;
			const done = await openOps.open(
				uiSession.opSessionFor(ctx, deps, device, env),
				this.openParams(what, opts, device, relaunch, settle.data)
			);
			if (!done.success || installed === undefined) return uiSession.reply(device, done);
			return uiSession.reply(device, resultFactory.ok(this.withKind(done.data, installed)));
		});
	}
}

export const uiOpen = new UiOpen();
