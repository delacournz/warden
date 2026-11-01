import { DEV_CLIENT_ARGS, metroTools } from "@delacour/warden-builds/metro";
import type { BuildKind } from "@delacour/warden-config/build-kinds";
import type { Driver } from "@delacour/warden-driver/driver.types";
import { androidToolsLocator } from "@delacour/warden-providers/android-tools";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { type ActionResult, actionFlow } from "./act";
import { controlOps } from "./controls";
import { opErrors } from "./errors";
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

export class OpenOps {
	/** Android only: make the host's Metro port reachable from the device, as `warden dev` does. */
	private async reverseMetro(session: OpSession, metroUrl: string): Promise<void> {
		if (session.device.platform !== "android") return;
		let port: number;
		try {
			port = Number(new URL(metroUrl).port);
		} catch {
			return;
		}
		if (!Number.isInteger(port) || port <= 0) return;
		const [, ...rest] = metroTools.adbReverseArgv(session.device.id, port);
		await session.host.exec([androidToolsLocator.locate(session.host.env).adb, ...rest]);
	}

	/** A failed or unsupported probe counts as "not running": the note is a courtesy, never a reason to fail. */
	private async isRunning(driver: Driver, bundleId: string): Promise<boolean> {
		const running = await driver.app.isRunning(bundleId);
		return running.success && running.data;
	}

	/** Launch an app; resolves to whether it was already running (and so attached to, not started). */
	async launchBundle(
		session: OpSession,
		driver: Driver,
		bundleId: string,
		opts: LaunchOptions
	): Promise<Result<{ attached: boolean }, WardenError>> {
		const extra = opts.args ?? [];
		if (opts.metro !== undefined) await this.reverseMetro(session, opts.metro);
		// an iOS dev client opens as `warden dev` opens it: no dev menu onboarding sheet or menu at launch
		const devClient = session.device.platform === "ios" ? [...DEV_CLIENT_ARGS, ...extra] : extra;
		const args = opts.metro === undefined ? [...extra] : metroTools.devClientLaunchArgs(opts.metro, devClient);
		const wasRunning = opts.relaunch === true ? false : await this.isRunning(driver, bundleId);
		const launched = opErrors.fromDriver(
			await driver.app.launch(bundleId, {
				...(args.length > 0 ? { args } : {}),
				relaunch: opts.relaunch === true,
			})
		);
		if (!launched.success) return launched;
		return resultFactory.ok({ attached: wasRunning });
	}

	private launchVerb(relaunch: boolean, attached: boolean): string {
		return relaunch ? "relaunched" : attached ? "attached to" : "launched";
	}

	/** Whether any flag that only a bundle-id launch understands is set. */
	private hasLaunchOptions(params: OpenParams): boolean {
		return (
			params.metro !== undefined ||
			params.relaunch === true ||
			(params.args?.length ?? 0) > 0 ||
			params.kind !== undefined ||
			params.project !== undefined
		);
	}

	/** `kind`, when given: refuse `metro` on a build with no dev client. */
	private kindConflict(params: OpenParams): WardenError | undefined {
		if (params.kind === undefined || params.metro === undefined || params.kind === "dev") return undefined;
		return opErrors.opError("usage", `--metro needs the dev client: --kind ${params.kind} runs without Metro`);
	}

	/** `open <url>`: hand the link to the system (accepting iOS's "Open in …?" sheet). */
	private async openUrl(session: OpSession, driver: Driver, params: OpenParams): OpOutcome<OpenResult> {
		const what = params.target;
		const facade = controlOps.deviceFacade(session, driver);
		const opened = await controlOps.viaFacade(() => facade.openLink(what));
		if (!opened.success) return opened;
		return actionFlow.finishAction(session, driver, params.settleMs, {
			action: "open",
			text: `opened ${what}`,
			args: { url: what },
			extra: { url: what },
		});
	}

	/** The one-line summary of a bundle launch, with the attach hint and the caller's note when they apply. */
	private bundleText(params: OpenParams, attached: boolean): string {
		const metro = params.metro ? ` (metro ${params.metro})` : "";
		const { build } = params;
		const built = build
			? ` (${build.kind} build${build.jsKey ? ` ${build.jsKey.slice(0, 12)}` : ""}${build.fallbackReason ? `, repack fallback: ${build.fallbackReason}` : ""})`
			: "";
		const hint = attached ? " (already running: attached, state kept; --relaunch starts it fresh)" : "";
		return [
			`${this.launchVerb(params.relaunch === true, attached)} ${params.target}${metro}${built}${hint}`,
			...(params.note !== undefined ? [params.note] : []),
		].join("\n");
	}

	/** `open <bundleId>`: launch (or attach to) the app and remember it, and the Metro URL, in the session's state. */
	private async openBundle(session: OpSession, driver: Driver, given: OpenParams): OpOutcome<OpenResult> {
		const what = given.target;
		// a build installed over a running app leaves the old process up: start the new one
		const relaunch = given.relaunch === true || given.build?.fresh === true;
		const params: OpenParams = { ...given, ...(relaunch ? { relaunch: true } : {}) };
		const launched = await this.launchBundle(session, driver, what, params);
		if (!launched.success) return launched;
		const { attached } = launched.data;
		const { build } = params;
		session.state.update((state) => ({
			...state,
			app: what,
			...(params.metro !== undefined ? { metroUrl: params.metro } : {}),
		}));
		return actionFlow.finishAction(session, driver, params.settleMs, {
			action: "open",
			text: this.bundleText(params, attached),
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
	async open(session: OpSession, params: OpenParams): OpOutcome<OpenResult> {
		const isUrl = URL_SCHEME.test(params.target);
		if (isUrl && this.hasLaunchOptions(params)) {
			return opErrors.fail(
				opErrors.opError("usage", "--metro, --relaunch, --args, --kind and --project apply to a bundle id, not a URL", {
					hint: "open the bundle id first, then the URL",
				})
			);
		}
		const conflict = this.kindConflict(params);
		if (conflict !== undefined) return opErrors.fail(conflict);
		const driver = await session.driver();
		if (!driver.success) return driver;
		return isUrl ? this.openUrl(session, driver.data, params) : this.openBundle(session, driver.data, params);
	}
}

export const openOps = new OpenOps();
