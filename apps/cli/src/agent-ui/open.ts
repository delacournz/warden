import type { BuildKind } from "@delacour/warden-core/builds/kinds";
import { androidTools } from "@delacour/warden-core/providers/android";
import type { Driver } from "@delacour/warden-e2e/driver/driver.types";
import type { Result } from "@delacour/warden-types/result";
import { resolveOwner } from "../claim-flags";
import type { CommandContext } from "../context";
import { adbReverseArgv, DEV_CLIENT_ARGS, devClientLaunchArgs } from "../metro";
import { type ActionOptionValues, finishAction, parseSettle } from "./act";
import { deviceFacade, viaFacade } from "./controls";
import { sharedNote, type UiDevice } from "./device";
import { fromDriver, type UiDeps } from "./driver";
import { type UiError, type UiSuccess, uiError } from "./output";
import { runUi, type UiRunEnv } from "./run";
import { readState, updateState } from "./state";

export type OpenOptionValues = ActionOptionValues & {
	relaunch?: true;
	/** Metro URL: launch the dev client with `--initialUrl <url>` (iOS: and `DEV_CLIENT_ARGS`) and remember it */
	metro?: string;
	/** extra launch arguments */
	args?: string[];
	/** `--kind`: install this build kind on the device first (`simulator` = this worktree's repacked JS), launch without Metro */
	kind?: BuildKind;
	/** `--project`: the app's project dir for `--kind` (default: cwd) */
	project?: string;
	/** `--a11y`: iOS launches carry the injected library from now on (remembered in `state.json`) */
	a11y?: true;
};

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Android only: make the host's Metro port reachable from the device, as `warden dev` does. */
async function reverseMetro(ctx: CommandContext, device: UiDevice, metroUrl: string): Promise<void> {
	if (device.platform !== "android") return;
	let port: number;
	try {
		port = Number(new URL(metroUrl).port);
	} catch {
		return;
	}
	if (!Number.isInteger(port) || port <= 0) return;
	const [, ...rest] = adbReverseArgv(device.udid, port);
	await ctx.exec([androidTools(ctx.env).adb, ...rest]);
}

export async function launchBundle(
	ctx: CommandContext,
	driver: Driver,
	device: UiDevice,
	bundleId: string,
	opts: Pick<OpenOptionValues, "relaunch" | "metro" | "args">
) {
	const extra = opts.args ?? [];
	if (opts.metro !== undefined) await reverseMetro(ctx, device, opts.metro);
	// an iOS dev client opens as `warden dev` opens it: no dev menu onboarding sheet or menu at launch
	const devClient = device.platform === "ios" ? [...DEV_CLIENT_ARGS, ...extra] : extra;
	const args = opts.metro === undefined ? extra : devClientLaunchArgs(opts.metro, devClient);
	const wasRunning = opts.relaunch === true ? false : await isRunning(driver, bundleId);
	const launched = fromDriver(
		await driver.app.launch(bundleId, {
			...(args.length > 0 ? { args } : {}),
			relaunch: opts.relaunch === true,
		})
	);
	if (!launched.success) return launched;
	return { success: true as const, data: { attached: wasRunning } };
}

/** A failed or unsupported probe counts as "not running": the note is a courtesy, never a reason to fail. */
async function isRunning(driver: Driver, bundleId: string): Promise<boolean> {
	const running = await driver.app.isRunning(bundleId);
	return running.success && running.data;
}

const launchVerb = (relaunch: boolean, attached: boolean): string =>
	relaunch ? "relaunched" : attached ? "attached to" : "launched";

/**
 * `warden ui open <bundleId|url> [--relaunch] [--metro <url>] [--args …]`. A bundle id launches the app
 * (`--relaunch` terminates it first; `--metro` starts the dev client on that Metro with `--initialUrl`). A URL is
 * opened through the system; on iOS the "Open in …?" sheet is accepted. The app and Metro URL are remembered
 * in `state.json` (`close --app` terminates that app).
 */
export function uiOpen(ctx: CommandContext, deps: UiDeps, what: string, opts: OpenOptionValues): Promise<number> {
	return runUi(ctx, deps, "open", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		const isUrl = URL_SCHEME.test(what);
		if (isUrl && hasLaunchOptions(opts)) {
			return {
				success: false,
				error: uiError("usage", "--metro, --relaunch, --args, --kind and --project apply to a bundle id, not a URL", {
					hint: "open the bundle id first, then the URL",
				}),
			};
		}
		const launch = isUrl ? opts : withA11yLaunch(ctx, device, opts);
		// remembered before the driver opens: it reads the flag to decide whether launches carry the injected library
		const driver = await env.driver();
		if (!driver.success) return driver;
		const open = isUrl ? openUrl : openBundle;
		return open({ ctx, deps, env, device, driver: driver.data, settle: settle.data, what, opts: launch });
	});
}

/**
 * `--a11y` on iOS: remember that launches carry the injected library. An app already running without it must start
 * again to load it, so the first `--a11y` implies `--relaunch`. Android reads accessibility facts natively: no-op.
 */
function withA11yLaunch(ctx: CommandContext, device: UiDevice, opts: OpenOptionValues): OpenOptionValues {
	if (opts.a11y !== true || device.platform !== "ios") return opts;
	const already = readState(ctx, device.udid).a11y === true;
	updateState(ctx, device.udid, (state) => ({ ...state, a11y: true }));
	return already ? opts : { ...opts, relaunch: true };
}

/** Whether any flag that only a bundle-id launch understands is set. */
function hasLaunchOptions(opts: OpenOptionValues): boolean {
	return (
		opts.metro !== undefined ||
		opts.relaunch === true ||
		(opts.args?.length ?? 0) > 0 ||
		opts.kind !== undefined ||
		opts.project !== undefined
	);
}

/** Everything one `warden ui open` needs once the device, driver and settle budget are resolved. */
type OpenRun = {
	ctx: CommandContext;
	deps: UiDeps;
	env: UiRunEnv;
	device: UiDevice;
	driver: Driver;
	settle: number | undefined;
	what: string;
	opts: OpenOptionValues;
};

/** `open <url>`: hand the link to the system (accepting iOS's "Open in …?" sheet). */
async function openUrl(run: OpenRun): Promise<Result<UiSuccess, UiError>> {
	const { ctx, deps, env, device, driver, settle, what } = run;
	const facade = deviceFacade(ctx, deps, device, driver, env.timeoutMs);
	const opened = await viaFacade(() => facade.openLink(what));
	if (!opened.success) return opened;
	return finishAction(ctx, deps, env, device, driver, settle, {
		action: "open",
		text: `opened ${what}`,
		args: { url: what },
		extra: { url: what },
	});
}

/** The one-line summary of a bundle launch, with the attach hint and the shared-device note when they apply. */
function bundleText(run: OpenRun, attached: boolean, installed?: KindInstall): string {
	const { what, opts, device } = run;
	const metro = opts.metro ? ` (metro ${opts.metro})` : "";
	const build = installed
		? ` (${installed.kind} build${installed.jsKey ? ` ${installed.jsKey.slice(0, 12)}` : ""}${installed.fallbackReason ? `, repack fallback: ${installed.fallbackReason}` : ""})`
		: "";
	const hint = attached ? " (already running: attached, state kept; --relaunch starts it fresh)" : "";
	return [
		`${launchVerb(opts.relaunch === true, attached)} ${what}${metro}${build}${hint}`,
		...(device.action === "attached" ? [sharedNote(device.lease)] : []),
	].join("\n");
}

/** What `--kind` put on the device: the build kind, its repack key and whether the device already ran it. */
type KindInstall = { kind: BuildKind; jsKey?: string; fresh: boolean; fallbackReason?: string };

/** `--kind`: make sure the kind's build is on the device (cached → repacked → built, then installed). */
async function installKind(run: OpenRun, kind: BuildKind): Promise<Result<KindInstall, UiError>> {
	const { ctx, deps, device, opts } = run;
	const ensure =
		deps.ensureApp ??
		(async (...args: Parameters<NonNullable<UiDeps["ensureApp"]>>) => {
			const { defaultAppDeps, ensureAppFor } = await import("../commands/app");
			return ensureAppFor(args[0], defaultAppDeps, args[1], args[2], args[3], args[4]);
		});
	const done = await ensure(ctx, resolveOwner(ctx), device.platform, device.udid, {
		eas: true,
		build: true,
		kind,
		...(opts.project !== undefined ? { project: opts.project } : {}),
	});
	if (!done.success) return { success: false, error: uiError("failed", `--kind ${kind}: ${done.error}`) };
	const app = "kindApp" in done.data ? done.data.kindApp : undefined;
	return {
		success: true,
		data: {
			kind: app?.kind ?? kind,
			fresh: done.data.source !== "installed",
			...(app?.kind === "simulator" ? { jsKey: app.repack.jsKey } : {}),
			...(app?.kind !== "simulator" && app?.fallbackReason !== undefined ? { fallbackReason: app.fallbackReason } : {}),
		},
	};
}

/** `--kind`, when given: refuse `--metro` on a build with no dev client, then install the kind. */
async function installRequestedKind(run: OpenRun): Promise<Result<KindInstall | undefined, UiError>> {
	const { kind, metro } = run.opts;
	if (kind === undefined) return { success: true, data: undefined };
	if (metro !== undefined && kind !== "dev") {
		return {
			success: false,
			error: uiError("usage", `--metro needs the dev client: --kind ${kind} runs without Metro`),
		};
	}
	return installKind(run, kind);
}

/** `open <bundleId>`: launch (or attach to) the app and remember it, and the Metro URL, in `state.json`. */
async function openBundle(run: OpenRun): Promise<Result<UiSuccess, UiError>> {
	const { ctx, deps, env, device, driver, settle, what, opts } = run;
	const kinded = await installRequestedKind(run);
	if (!kinded.success) return kinded;
	const installed = kinded.data;
	// a build installed over a running app leaves the old process up: start the new one
	const relaunch = opts.relaunch === true || installed?.fresh === true;
	const launchOpts = { ...opts, ...(relaunch ? { relaunch: true as const } : {}) };
	const launched = await launchBundle(ctx, driver, device, what, launchOpts);
	if (!launched.success) return launched;
	const attached = launched.data.attached;
	updateState(ctx, device.udid, (state) => ({
		...state,
		app: what,
		...(opts.metro !== undefined ? { metroUrl: opts.metro } : {}),
	}));
	return finishAction(ctx, deps, env, device, driver, settle, {
		action: "open",
		text: bundleText({ ...run, opts: launchOpts }, attached, installed),
		args: {
			bundleId: what,
			relaunch,
			...(opts.metro !== undefined ? { metro: opts.metro } : {}),
			...(opts.kind !== undefined ? { kind: opts.kind } : {}),
		},
		extra: {
			bundleId: what,
			relaunch,
			attached,
			...(opts.metro !== undefined ? { metroUrl: opts.metro } : {}),
			...(installed ? { kind: installed.kind, ...(installed.jsKey ? { jsKey: installed.jsKey } : {}) } : {}),
			...(installed?.fallbackReason !== undefined ? { fallbackReason: installed.fallbackReason } : {}),
		},
	});
}
