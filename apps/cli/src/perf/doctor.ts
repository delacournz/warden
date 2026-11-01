import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Command as Commander } from "@commander-js/extra-typings";
import { appDetector } from "@delacour/warden-perf/shared/app-detect";
import { doctorParser } from "@delacour/warden-perf/shared/doctor-parse";
import { androidToolsLocator } from "@delacour/warden-providers/android-tools";
import { storeLocator } from "@delacour/warden-store/store";
import type { CommandContext } from "../context";
import { output } from "../output";
import { SYMBOLS } from "../ui";
import { perfAppCli } from "./app";
import { type PerfTarget, perfDeviceCli } from "./device";
import { perfOptionsCli } from "./options";
import type { PerfDeps, PerfOptionValues } from "./run";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export type DoctorCheck = { id: string; status: CheckStatus; detail: string; hint?: string };

const NATIVE_INSTRUMENTS = ["Time Profiler", "Hangs", "Leaks", "Allocations"] as const;

export class PerfDoctorCli {
	private check(id: string, status: CheckStatus, detail: string, hint?: string): DoctorCheck {
		return {
			id,
			status,
			detail,
			...(hint !== undefined ? { hint } : {}),
		};
	}

	private async xctraceCheck(ctx: CommandContext, deps: PerfDeps): Promise<DoctorCheck> {
		if (deps.host.platform !== "darwin") return this.check("xctrace", "skip", "not macOS");
		const res = await ctx.exec(["xcrun", "xctrace", "version"], { timeoutMs: 15_000 });
		const version = res.exitCode === 0 ? doctorParser.parseXctraceVersion(res.stdout) : undefined;
		return version === undefined
			? this.check("xctrace", "fail", "xcrun xctrace not found", "install Xcode, then xcode-select --install")
			: this.check("xctrace", "ok", version);
	}

	private async xcodeCheck(ctx: CommandContext, deps: PerfDeps): Promise<DoctorCheck> {
		if (deps.host.platform !== "darwin") return this.check("xcode", "skip", "not macOS");
		const res = await ctx.exec(["xcodebuild", "-version"], { timeoutMs: 15_000 });
		const version = res.exitCode === 0 ? doctorParser.parseXcodeVersion(res.stdout) : undefined;
		if (version === undefined)
			return this.check(
				"xcode",
				"warn",
				"xcodebuild -version failed",
				"select Xcode: sudo xcode-select -s /Applications/Xcode.app"
			);
		return doctorParser.xctraceDeviceDeadlock(version)
			? this.check(
					"xcode",
					"warn",
					`Xcode ${version.text}: xctrace --device deadlocks on 26.4+`,
					"warden perf records with --all-processes and filters by pid instead"
				)
			: this.check("xcode", "ok", `Xcode ${version.text}`);
	}

	/** `xctrace list instruments` has what `perf native` records with (Time Profiler, Hangs, Leaks, Allocations). */
	private async instrumentsCheck(ctx: CommandContext, deps: PerfDeps): Promise<DoctorCheck> {
		if (deps.host.platform !== "darwin") return this.check("instruments", "skip", "not macOS");
		const { instrumentChecker } = await import("@delacour/warden-perf/ios/instruments");
		const found = await instrumentChecker.checkXctraceInstruments(
			(argv) => ctx.exec(argv, { timeoutMs: 30_000 }),
			NATIVE_INSTRUMENTS
		);
		if (found === undefined) return this.check("instruments", "skip", "xctrace list instruments failed");
		if (found.ok) return this.check("instruments", "ok", NATIVE_INSTRUMENTS.join(", "));
		const alts = found.missing.map((m) => `${m} (try: ${found.alternatives[m]?.join(", ") || "none"})`);
		return this.check(
			"instruments",
			"warn",
			`missing ${alts.join("; ")}`,
			"perf native needs Time Profiler + Hangs (Leaks for --leaks; Allocations is optional); update Xcode"
		);
	}

	private async adbCheck(ctx: CommandContext): Promise<DoctorCheck> {
		const res = await ctx.exec([androidToolsLocator.locate(ctx.env).adb, "version"], { timeoutMs: 10_000 });
		const version = res.exitCode === 0 ? doctorParser.parseAdbVersion(res.stdout) : undefined;
		return version === undefined
			? this.check(
					"adb",
					"warn",
					"adb not found (Android profiling unavailable)",
					"install platform-tools or set ANDROID_HOME"
				)
			: this.check("adb", "ok", version);
	}

	private traceProcessorCheck(ctx: CommandContext): DoctorCheck {
		let names: string[] = [];
		try {
			names = readdirSync(join(storeLocator.wardenHome(ctx.env), "tools"));
		} catch {
			// no tools dir yet
		}
		const cached = names.find((n) => n.startsWith("trace_processor_shell-"));
		return cached === undefined
			? this.check(
					"trace-processor",
					"warn",
					"not cached (needed for Android --native analysis)",
					"warden perf tools install trace-processor"
				)
			: this.check(
					"trace-processor",
					"ok",
					cached.slice("trace_processor_shell-".length)
						? `cached ${cached.slice("trace_processor_shell-".length)}`
						: "cached"
				);
	}

	private async deviceToolsCheck(
		ctx: CommandContext,
		device: PerfTarget | undefined,
		why: string
	): Promise<DoctorCheck> {
		if (device === undefined) return this.check("device-tools", "skip", why);
		if (device.platform !== "android")
			return this.check("device-tools", "skip", "iOS simulator (xctrace runs on the host)");
		const res = await ctx.exec(
			[androidToolsLocator.locate(ctx.env).adb, "-s", device.udid, "shell", "which", "perfetto", "simpleperf"],
			{
				timeoutMs: 10_000,
			}
		);
		const tools = doctorParser.parseDeviceTools(res.stdout);
		const present = Object.entries(tools).flatMap(([name, has]) => (has ? [name] : []));
		const missing = Object.entries(tools).flatMap(([name, has]) => (has ? [] : [name]));
		if (missing.length === 0) return this.check("device-tools", "ok", present.join(", "));
		return this.check(
			"device-tools",
			"warn",
			`${present.join(", ") || "none"} on device`,
			`missing ${missing.join(", ")}: use an Android 9+ image (perfetto) / a userdebug or Play-less image (simpleperf)`
		);
	}

	private async appCheck(
		ctx: CommandContext,
		device: PerfTarget | undefined,
		flag: string | undefined,
		why: string
	): Promise<DoctorCheck> {
		if (device === undefined) return this.check("app", "skip", why);
		const app = await perfAppCli.resolveApp(ctx, { platform: device.platform, id: device.udid }, flag);
		if (!app.success) return this.check("app", "warn", app.error.message, app.error.hint);
		if (device.platform === "ios") return this.check("app", "ok", `${app.data.id} (${app.data.source})`);
		const res = await ctx.exec(
			[androidToolsLocator.locate(ctx.env).adb, "-s", device.udid, "shell", "dumpsys", "package", app.data.id],
			{
				timeoutMs: 15_000,
			}
		);
		if (res.exitCode !== 0) return this.check("app", "warn", `${app.data.id}: dumpsys package failed`);
		const flags = appDetector.parsePackageFlags(res.stdout);
		if (flags.debuggable || flags.profileable) {
			return this.check("app", "ok", `${app.data.id} (${flags.debuggable ? "debuggable" : "profileable"})`);
		}
		return this.check(
			"app",
			"warn",
			`${app.data.id} is neither debuggable nor profileable`,
			'add <profileable android:shell="true"/> inside <application> in AndroidManifest.xml (release builds)'
		);
	}

	private async metroCheck(ctx: CommandContext, deps: PerfDeps, device: PerfTarget | undefined): Promise<DoctorCheck> {
		const url = await deps.host.metro(ctx, device?.udid);
		return url === undefined
			? this.check(
					"metro",
					"warn",
					"no Metro found (JS and React profiling need a dev client on Metro)",
					"warden dev <platform>"
				)
			: this.check("metro", "ok", url);
	}

	private line(ctx: CommandContext, c: DoctorCheck): string[] {
		const { color } = ctx.ui;
		const glyph =
			c.status === "ok"
				? color.green(SYMBOLS.ok)
				: c.status === "fail"
					? color.red(SYMBOLS.fail)
					: c.status === "warn"
						? color.yellow(SYMBOLS.warn)
						: color.dim(SYMBOLS.idle);
		return [`${glyph} ${c.id.padEnd(16)} ${c.detail}`, ...(c.hint !== undefined ? [color.dim(`    ${c.hint}`)] : [])];
	}

	/**
	 * `warden perf doctor`: what profiling needs on this host and (when a warden device resolves) on that device.
	 * Read-only: it never leases or touches the device. Exit 1 only on a `fail` (xctrace missing on macOS).
	 */
	async perfDoctor(ctx: CommandContext, deps: PerfDeps, opts: PerfOptionValues): Promise<number> {
		const resolved = await perfDeviceCli.resolvePerfDevice(ctx, opts, "observe", deps.device);
		const device = resolved.success ? resolved.data : undefined;
		const why = resolved.success ? "" : resolved.error.message;
		const checks: DoctorCheck[] = [
			await this.xctraceCheck(ctx, deps),
			await this.xcodeCheck(ctx, deps),
			await this.instrumentsCheck(ctx, deps),
			await this.adbCheck(ctx),
			await this.deviceToolsCheck(ctx, device, why),
			this.traceProcessorCheck(ctx),
			await this.metroCheck(ctx, deps, device),
			await this.appCheck(ctx, device, opts.app, why),
		];
		const ok = checks.every((c) => c.status !== "fail");
		const info = device && { udid: device.udid, platform: device.platform, name: device.name };
		const header = info ? `${info.udid} ${info.name ?? ""} (${info.platform})`.trim() : `no device: ${why}`;
		const text = [ctx.ui.color.dim(header), ...checks.flatMap((c) => this.line(ctx, c))].join("\n");
		output.emit(ctx, opts.json === true, { ok, ...(info ? { device: info } : {}), checks }, text, {
			scope: "perf doctor",
		});
		return ok ? 0 : 1;
	}

	/** Wire `doctor` onto `warden perf`. */
	readonly registerDoctor = (
		cmd: Commander,
		ctx: CommandContext,
		done: (code: number) => void,
		deps: PerfDeps
	): void => {
		perfOptionsCli
			.withPerfOptions(
				cmd
					.command("doctor")
					.description(
						"what profiling needs: xctrace / Xcode, adb + device tools, trace_processor, Metro, a profileable app"
					)
			)
			.action(async (opts) => {
				done(await this.perfDoctor(ctx, deps, opts));
			});
	};
}

export const perfDoctorCli = new PerfDoctorCli();
