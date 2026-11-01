import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AmStart, amStartParser } from "@delacour/warden-perf/startup/android-am-start";
import { iosAppLaunch } from "@delacour/warden-perf/startup/ios-app-launch";
import { androidToolsLocator } from "@delacour/warden-providers/android-tools";
import type { Platform } from "@delacour/warden-store/types";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { opErrors } from "../errors";
import { appProcess } from "./app-process";
import type { PerfEnv } from "./env";

/** Relaunch primitives: the pieces `perf startup` times and `perf start --relaunch|--reset` arms capturers around. All mutate the app, so callers hold the device lease. */
type AppDevice = { platform: Platform; id: string };

/** Clock and scratch space `relaunch` reaches the host through; tests inject fakes. */
export type RelaunchIo = {
	/** monotonic milliseconds: the wall time of an iOS launch */
	monotonicMs: () => number;
	/** a fresh empty directory (the `.app` copy a reset reinstalls from) */
	mkdtemp: () => string;
	rm: (path: string) => void;
};

export const defaultRelaunchIo: RelaunchIo = {
	monotonicMs: () => performance.now(),
	mkdtemp: () => mkdtempSync(join(tmpdir(), "warden-perf-")),
	rm: (path) => rmSync(path, { recursive: true, force: true }),
};

export type LaunchFailure = "no_launcher" | "launch_failed";

/** `launched`: the app was started (`wallMs` host time around the start command; `am` the system's own timing on Android). */
export type LaunchResult =
	| { kind: "launched"; wallMs: number; pid?: number; component?: string; am?: AmStart }
	| { kind: "failed"; reason: LaunchFailure; message: string; hint?: string };

export type LaunchOptions = {
	/** Android `-S` / iOS `--terminate-running-process`: stop a running copy first, so the launch is cold */
	cold: boolean;
	/** Android launcher component, when already resolved (saves an exec per launch) */
	component?: string;
};

/** AppRelauncher: relaunch. */
export class AppRelauncher {
	private readonly adb = (ctx: PerfEnv, device: AppDevice, args: readonly string[]): string[] => [
		androidToolsLocator.locate(ctx.env).adb,
		"-s",
		device.id,
		...args,
	];

	private readonly failed = (message: string, hint?: string): WardenError =>
		opErrors.opError("failed", message, hint === undefined ? {} : { hint });

	/** The app's launcher activity (`pkg/.Activity`), from `cmd package resolve-activity --brief`. */
	async resolveLauncher(ctx: PerfEnv, device: AppDevice, appId: string): Promise<Result<string, WardenError>> {
		const res = await ctx.exec(this.adb(ctx, device, amStartParser.resolveActivityArgv(appId)), { timeoutMs: 15_000 });
		const component = res.exitCode === 0 ? amStartParser.parseResolveActivity(res.stdout) : undefined;
		if (component === undefined) {
			return {
				success: false,
				error: opErrors.opError("app_not_found", `${appId} has no launcher activity on ${device.id}`, {
					hint: "install the app (warden dev android) or pass --app <package>",
				}),
			};
		}
		return resultFactory.ok(component);
	}

	/** Stop the app (`am force-stop` / `simctl terminate`); an app that was not running is not an error. */
	async terminateApp(ctx: PerfEnv, device: AppDevice, appId: string): Promise<Result<undefined, WardenError>> {
		if (device.platform === "android") {
			const res = await ctx.exec(this.adb(ctx, device, ["shell", "am", "force-stop", appId]), { timeoutMs: 15_000 });
			return res.exitCode === 0
				? resultFactory.ok(undefined)
				: {
						success: false,
						error: this.failed(`am force-stop ${appId} failed: ${res.stderr.trim() || res.stdout.trim()}`),
					};
		}
		const res = await ctx.exec(["xcrun", "simctl", "terminate", device.id, appId], { timeoutMs: 15_000 });
		const text = `${res.stdout}${res.stderr}`;
		if (res.exitCode === 0 || /found nothing to terminate/i.test(text)) return resultFactory.ok(undefined);
		return { success: false, error: this.failed(`simctl terminate ${appId} failed: ${text.trim()}`) };
	}

	private async launchAndroid(
		ctx: PerfEnv,
		device: AppDevice,
		appId: string,
		opts: LaunchOptions,
		io: RelaunchIo
	): Promise<LaunchResult> {
		let component = opts.component;
		if (component === undefined) {
			const resolved = await this.resolveLauncher(ctx, device, appId);
			if (!resolved.success) {
				return {
					kind: "failed",
					reason: "no_launcher",
					message: resolved.error.message,
					...(resolved.error.hint ? { hint: resolved.error.hint } : {}),
				};
			}
			component = resolved.data;
		}
		const t0 = io.monotonicMs();
		const res = await ctx.exec(this.adb(ctx, device, amStartParser.amStartArgv(component, opts.cold)), {
			timeoutMs: 60_000,
		});
		const wallMs = Math.round(io.monotonicMs() - t0);
		const parsed = amStartParser.parseAmStart(`${res.stdout}\n${res.stderr}`);
		if (res.exitCode !== 0 && !parsed.success) {
			return { kind: "failed", reason: "launch_failed", message: parsed.error };
		}
		if (!parsed.success) return { kind: "failed", reason: "launch_failed", message: parsed.error };
		return { kind: "launched", wallMs, component, am: parsed.data };
	}

	private async launchIos(
		ctx: PerfEnv,
		device: AppDevice,
		appId: string,
		opts: LaunchOptions,
		io: RelaunchIo
	): Promise<LaunchResult> {
		const t0 = io.monotonicMs();
		const res = await ctx.exec(iosAppLaunch.simctlLaunchArgv(device.id, appId, opts.cold), { timeoutMs: 60_000 });
		const wallMs = Math.round(io.monotonicMs() - t0);
		if (res.exitCode !== 0) {
			return {
				kind: "failed",
				reason: "launch_failed",
				message: `simctl launch ${appId} failed: ${(res.stderr || res.stdout).trim()}`,
				hint: "is the app installed? warden dev ios installs it",
			};
		}
		const pid = iosAppLaunch.parseSimctlLaunch(res.stdout);
		return { kind: "launched", wallMs, ...(pid !== undefined ? { pid } : {}) };
	}

	/** Start the app and wait for the launch to settle (`am start -W` / `simctl launch`), timing it. `cold` stops a running copy first. */
	launchApp(
		ctx: PerfEnv,
		device: AppDevice,
		appId: string,
		opts: LaunchOptions,
		io: RelaunchIo = defaultRelaunchIo
	): Promise<LaunchResult> {
		return device.platform === "android"
			? this.launchAndroid(ctx, device, appId, opts, io)
			: this.launchIos(ctx, device, appId, opts, io);
	}

	/**
	 * Wipe the app's data, keeping the exact build. Android: `pm clear`. iOS: copy the installed `.app` aside, uninstall
	 * (which drops the data container), reinstall from the copy; the copy is removed afterwards. Leaves the app stopped.
	 */
	async resetAppData(
		ctx: PerfEnv,
		device: AppDevice,
		appId: string,
		io: RelaunchIo = defaultRelaunchIo
	): Promise<Result<undefined, WardenError>> {
		if (device.platform === "android") {
			const res = await ctx.exec(this.adb(ctx, device, ["shell", "pm", "clear", appId]), { timeoutMs: 30_000 });
			return res.exitCode === 0 && /success/i.test(res.stdout)
				? resultFactory.ok(undefined)
				: { success: false, error: this.failed(`pm clear ${appId} failed: ${(res.stdout || res.stderr).trim()}`) };
		}
		const bundle = await appProcess.iosAppBundle(ctx, device.id, appId);
		if (!bundle.success) return bundle;
		const scratch = io.mkdtemp();
		let keep = false;
		try {
			const copy = await ctx.exec(["cp", "-R", bundle.data.appPath, scratch], { timeoutMs: 120_000 });
			if (copy.exitCode !== 0) {
				return { success: false, error: this.failed(`copying ${bundle.data.appPath} failed: ${copy.stderr.trim()}`) };
			}
			const copied = join(scratch, bundle.data.appPath.split("/").pop() ?? "");
			const gone = await ctx.exec(["xcrun", "simctl", "uninstall", device.id, appId], { timeoutMs: 60_000 });
			if (gone.exitCode !== 0) {
				return { success: false, error: this.failed(`simctl uninstall ${appId} failed: ${gone.stderr.trim()}`) };
			}
			const back = await ctx.exec(["xcrun", "simctl", "install", device.id, copied], { timeoutMs: 120_000 });
			if (back.exitCode === 0) return resultFactory.ok(undefined);
			keep = true;
			return {
				success: false,
				error: this.failed(
					`simctl install failed after uninstall: ${back.stderr.trim()}`,
					`the copy is kept: xcrun simctl install ${device.id} ${copied}`
				),
			};
		} finally {
			if (!keep) io.rm(scratch);
		}
	}
}

export const appRelauncher = new AppRelauncher();
