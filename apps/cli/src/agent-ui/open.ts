import { androidTools } from "@delacour/warden-core/providers/android";
import type { Driver } from "@delacour/warden-e2e/driver/driver.types";
import type { Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { adbReverseArgv, devClientLaunchArgs } from "../metro";
import { type ActionOptionValues, finishAction, parseSettle } from "./act";
import { deviceFacade, viaFacade } from "./controls";
import { sharedNote, type UiDevice } from "./device";
import { fromDriver, type UiDeps } from "./driver";
import { type UiError, type UiSuccess, uiError } from "./output";
import { runUi, type UiRunEnv } from "./run";
import { updateState } from "./state";

export type OpenOptionValues = ActionOptionValues & {
	relaunch?: true;
	/** Metro URL: launch the dev client with `--initialUrl <url>` and remember it */
	metro?: string;
	/** extra launch arguments */
	args?: string[];
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
	const args = opts.metro === undefined ? extra : devClientLaunchArgs(opts.metro, extra);
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
				error: uiError("usage", "--metro, --relaunch and --args apply to a bundle id, not a URL", {
					hint: "open the bundle id first, then the URL",
				}),
			};
		}
		const driver = await env.driver();
		if (!driver.success) return driver;
		const open = isUrl ? openUrl : openBundle;
		return open({ ctx, deps, env, device, driver: driver.data, settle: settle.data, what, opts });
	});
}

/** Whether any flag that only a bundle-id launch understands is set. */
function hasLaunchOptions(opts: OpenOptionValues): boolean {
	return opts.metro !== undefined || opts.relaunch === true || (opts.args?.length ?? 0) > 0;
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
function bundleText(run: OpenRun, attached: boolean): string {
	const { what, opts, device } = run;
	const metro = opts.metro ? ` (metro ${opts.metro})` : "";
	const hint = attached ? " (already running: attached, state kept; --relaunch starts it fresh)" : "";
	return [
		`${launchVerb(opts.relaunch === true, attached)} ${what}${metro}${hint}`,
		...(device.action === "attached" ? [sharedNote(device.lease)] : []),
	].join("\n");
}

/** `open <bundleId>`: launch (or attach to) the app and remember it, and the Metro URL, in `state.json`. */
async function openBundle(run: OpenRun): Promise<Result<UiSuccess, UiError>> {
	const { ctx, deps, env, device, driver, settle, what, opts } = run;
	const launched = await launchBundle(ctx, driver, device, what, opts);
	if (!launched.success) return launched;
	const attached = launched.data.attached;
	updateState(ctx, device.udid, (state) => ({
		...state,
		app: what,
		...(opts.metro !== undefined ? { metroUrl: opts.metro } : {}),
	}));
	return finishAction(ctx, deps, env, device, driver, settle, {
		action: "open",
		text: bundleText(run, attached),
		args: {
			bundleId: what,
			relaunch: opts.relaunch === true,
			...(opts.metro !== undefined ? { metro: opts.metro } : {}),
		},
		extra: {
			bundleId: what,
			relaunch: opts.relaunch === true,
			attached,
			...(opts.metro !== undefined ? { metroUrl: opts.metro } : {}),
		},
	});
}
