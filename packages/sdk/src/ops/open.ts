import { adbReverseArgv, DEV_CLIENT_ARGS, devClientLaunchArgs } from "@delacour/warden-builds/metro";
import type { BuildKind } from "@delacour/warden-config/build-kinds";
import type { Driver } from "@delacour/warden-driver/driver.types";
import { androidTools } from "@delacour/warden-providers/android-tools";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { type ActionResult, finishAction } from "./act";
import { deviceFacade, viaFacade } from "./controls";
import { fail, fromDriver, opError } from "./errors";
import type { OpOutcome, OpSession } from "./session";

export type LaunchOptions = {
	/** terminate a running app first */
	relaunch?: boolean;
	/** Metro URL: launch the dev client with `--initialUrl <url>` */
	metro?: string;
	/** extra launch arguments */
	args?: readonly string[];
};

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Android only: make the host's Metro port reachable from the device, as `warden dev` does. */
async function reverseMetro(session: OpSession, metroUrl: string): Promise<void> {
	if (session.device.platform !== "android") return;
	let port: number;
	try {
		port = Number(new URL(metroUrl).port);
	} catch {
		return;
	}
	if (!Number.isInteger(port) || port <= 0) return;
	const [, ...rest] = adbReverseArgv(session.device.id, port);
	await session.host.exec([androidTools(session.host.env).adb, ...rest]);
}

/** A failed or unsupported probe counts as "not running": the note is a courtesy, never a reason to fail. */
async function isRunning(driver: Driver, bundleId: string): Promise<boolean> {
	const running = await driver.app.isRunning(bundleId);
	return running.success && running.data;
}

/** Launch an app; resolves to whether it was already running (and so attached to, not started). */
export async function launchBundle(
	session: OpSession,
	driver: Driver,
	bundleId: string,
	opts: LaunchOptions
): Promise<Result<{ attached: boolean }, WardenError>> {
	const extra = opts.args ?? [];
	if (opts.metro !== undefined) await reverseMetro(session, opts.metro);
	// an iOS dev client opens as `warden dev` opens it: no dev menu onboarding sheet or menu at launch
	const devClient = session.device.platform === "ios" ? [...DEV_CLIENT_ARGS, ...extra] : extra;
	const args = opts.metro === undefined ? [...extra] : devClientLaunchArgs(opts.metro, devClient);
	const wasRunning = opts.relaunch === true ? false : await isRunning(driver, bundleId);
	const launched = fromDriver(
		await driver.app.launch(bundleId, {
			...(args.length > 0 ? { args } : {}),
			relaunch: opts.relaunch === true,
		})
	);
	if (!launched.success) return launched;
	return resultFactory.ok({ attached: wasRunning });
}

const launchVerb = (relaunch: boolean, attached: boolean): string =>
	relaunch ? "relaunched" : attached ? "attached to" : "launched";

/** What `kind` put on the device: the build kind, its repack key and whether the device already ran it. */
export type KindBuild = { kind: BuildKind; jsKey?: string; fresh: boolean; fallbackReason?: string };

export type OpenParams = LaunchOptions & {
	/** a bundle id (launches the app) or a URL (opened through the system) */
	target: string;
	settleMs?: number;
	/** a line printed under a bundle launch (the CLI names the `warden dev` lease it shares) */
	note?: string;
	/** `--kind`: the build kind the caller wants on the device (launch without Metro); the caller installs it, see `build` */
	kind?: BuildKind;
	/** the project dir `kind` was built from (`--project`); only a flag the bundle-id launch understands */
	project?: string;
	/** the install `kind` led to, done by the caller before `open` (an app build is the CLI's `ensureAppFor`) */
	build?: KindBuild;
};
export type OpenResult =
	| (ActionResult & { url: string })
	| (ActionResult & {
			bundleId: string;
			relaunch: boolean;
			attached: boolean;
			metroUrl?: string;
			kind?: BuildKind;
			jsKey?: string;
			fallbackReason?: string;
	  });

/** Whether any flag that only a bundle-id launch understands is set. */
function hasLaunchOptions(params: OpenParams): boolean {
	return (
		params.metro !== undefined ||
		params.relaunch === true ||
		(params.args?.length ?? 0) > 0 ||
		params.kind !== undefined ||
		params.project !== undefined
	);
}

/** `kind`, when given: refuse `metro` on a build with no dev client. */
function kindConflict(params: OpenParams): WardenError | undefined {
	if (params.kind === undefined || params.metro === undefined || params.kind === "dev") return undefined;
	return opError("usage", `--metro needs the dev client: --kind ${params.kind} runs without Metro`);
}

/** `open <url>`: hand the link to the system (accepting iOS's "Open in …?" sheet). */
async function openUrl(session: OpSession, driver: Driver, params: OpenParams): OpOutcome<OpenResult> {
	const what = params.target;
	const facade = deviceFacade(session, driver);
	const opened = await viaFacade(() => facade.openLink(what));
	if (!opened.success) return opened;
	return finishAction(session, driver, params.settleMs, {
		action: "open",
		text: `opened ${what}`,
		args: { url: what },
		extra: { url: what },
	});
}

/** The one-line summary of a bundle launch, with the attach hint and the caller's note when they apply. */
function bundleText(params: OpenParams, attached: boolean): string {
	const metro = params.metro ? ` (metro ${params.metro})` : "";
	const { build } = params;
	const built = build
		? ` (${build.kind} build${build.jsKey ? ` ${build.jsKey.slice(0, 12)}` : ""}${build.fallbackReason ? `, repack fallback: ${build.fallbackReason}` : ""})`
		: "";
	const hint = attached ? " (already running: attached, state kept; --relaunch starts it fresh)" : "";
	return [
		`${launchVerb(params.relaunch === true, attached)} ${params.target}${metro}${built}${hint}`,
		...(params.note !== undefined ? [params.note] : []),
	].join("\n");
}

/** `open <bundleId>`: launch (or attach to) the app and remember it, and the Metro URL, in the session's state. */
async function openBundle(session: OpSession, driver: Driver, given: OpenParams): OpOutcome<OpenResult> {
	const what = given.target;
	// a build installed over a running app leaves the old process up: start the new one
	const relaunch = given.relaunch === true || given.build?.fresh === true;
	const params: OpenParams = { ...given, ...(relaunch ? { relaunch: true } : {}) };
	const launched = await launchBundle(session, driver, what, params);
	if (!launched.success) return launched;
	const { attached } = launched.data;
	const { build } = params;
	session.state.update((state) => ({
		...state,
		app: what,
		...(params.metro !== undefined ? { metroUrl: params.metro } : {}),
	}));
	return finishAction(session, driver, params.settleMs, {
		action: "open",
		text: bundleText(params, attached),
		args: {
			bundleId: what,
			relaunch,
			...(params.metro !== undefined ? { metro: params.metro } : {}),
			...(params.kind !== undefined ? { kind: params.kind } : {}),
		},
		extra: {
			bundleId: what,
			relaunch,
			attached,
			...(params.metro !== undefined ? { metroUrl: params.metro } : {}),
			...(build ? { kind: build.kind, ...(build.jsKey ? { jsKey: build.jsKey } : {}) } : {}),
			...(build?.fallbackReason !== undefined ? { fallbackReason: build.fallbackReason } : {}),
		},
	});
}

/**
 * `warden ui open <bundleId|url> [--relaunch] [--metro <url>] [--args …]`. A bundle id launches the app
 * (`relaunch` terminates it first; `metro` starts the dev client on that Metro with `--initialUrl`). A URL is
 * opened through the system; on iOS the "Open in …?" sheet is accepted. The app and Metro URL are remembered
 * in the session's state (`close --app` terminates that app).
 */
export async function open(session: OpSession, params: OpenParams): OpOutcome<OpenResult> {
	const isUrl = URL_SCHEME.test(params.target);
	if (isUrl && hasLaunchOptions(params)) {
		return fail(
			opError("usage", "--metro, --relaunch, --args, --kind and --project apply to a bundle id, not a URL", {
				hint: "open the bundle id first, then the URL",
			})
		);
	}
	const conflict = kindConflict(params);
	if (conflict !== undefined) return fail(conflict);
	const driver = await session.driver();
	if (!driver.success) return driver;
	return isUrl ? openUrl(session, driver.data, params) : openBundle(session, driver.data, params);
}
