import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Command as Commander } from "@commander-js/extra-typings";
import { androidTools } from "@delacour/warden-core/providers/android";
import { wardenHome } from "@delacour/warden-core/store";
import { parsePackageFlags } from "@delacour/warden-perf/shared/app-detect";
import {
	parseAdbVersion,
	parseDeviceTools,
	parseXcodeVersion,
	parseXctraceVersion,
	xctraceDeviceDeadlock,
} from "@delacour/warden-perf/shared/doctor-parse";
import type { CommandContext } from "../context";
import { emit } from "../output";
import { SYMBOLS } from "../ui";
import { resolveApp } from "./app";
import { type PerfTarget, resolvePerfDevice } from "./device";
import { withPerfOptions } from "./options";
import type { PerfDeps, PerfOptionValues } from "./run";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export type DoctorCheck = { id: string; status: CheckStatus; detail: string; hint?: string };

const check = (id: string, status: CheckStatus, detail: string, hint?: string): DoctorCheck => ({
	id,
	status,
	detail,
	...(hint !== undefined ? { hint } : {}),
});

async function xctraceCheck(ctx: CommandContext, deps: PerfDeps): Promise<DoctorCheck> {
	if (deps.host.platform !== "darwin") return check("xctrace", "skip", "not macOS");
	const res = await ctx.exec(["xcrun", "xctrace", "version"], { timeoutMs: 15_000 });
	const version = res.exitCode === 0 ? parseXctraceVersion(res.stdout) : undefined;
	return version === undefined
		? check("xctrace", "fail", "xcrun xctrace not found", "install Xcode, then xcode-select --install")
		: check("xctrace", "ok", version);
}

async function xcodeCheck(ctx: CommandContext, deps: PerfDeps): Promise<DoctorCheck> {
	if (deps.host.platform !== "darwin") return check("xcode", "skip", "not macOS");
	const res = await ctx.exec(["xcodebuild", "-version"], { timeoutMs: 15_000 });
	const version = res.exitCode === 0 ? parseXcodeVersion(res.stdout) : undefined;
	if (version === undefined)
		return check(
			"xcode",
			"warn",
			"xcodebuild -version failed",
			"select Xcode: sudo xcode-select -s /Applications/Xcode.app"
		);
	return xctraceDeviceDeadlock(version)
		? check(
				"xcode",
				"warn",
				`Xcode ${version.text}: xctrace --device deadlocks on 26.4+`,
				"warden perf records with --all-processes and filters by pid instead"
			)
		: check("xcode", "ok", `Xcode ${version.text}`);
}

const NATIVE_INSTRUMENTS = ["Time Profiler", "Hangs", "Leaks", "Allocations"] as const;

/** `xctrace list instruments` has what `perf native` records with (Time Profiler, Hangs, Leaks, Allocations). */
async function instrumentsCheck(ctx: CommandContext, deps: PerfDeps): Promise<DoctorCheck> {
	if (deps.host.platform !== "darwin") return check("instruments", "skip", "not macOS");
	const { checkXctraceInstruments } = await import("@delacour/warden-perf/ios/instruments");
	const found = await checkXctraceInstruments((argv) => ctx.exec(argv, { timeoutMs: 30_000 }), NATIVE_INSTRUMENTS);
	if (found === undefined) return check("instruments", "skip", "xctrace list instruments failed");
	if (found.ok) return check("instruments", "ok", NATIVE_INSTRUMENTS.join(", "));
	const alts = found.missing.map((m) => `${m} (try: ${found.alternatives[m]?.join(", ") || "none"})`);
	return check(
		"instruments",
		"warn",
		`missing ${alts.join("; ")}`,
		"perf native needs Time Profiler + Hangs (Leaks for --leaks; Allocations is optional); update Xcode"
	);
}

async function adbCheck(ctx: CommandContext): Promise<DoctorCheck> {
	const res = await ctx.exec([androidTools(ctx.env).adb, "version"], { timeoutMs: 10_000 });
	const version = res.exitCode === 0 ? parseAdbVersion(res.stdout) : undefined;
	return version === undefined
		? check(
				"adb",
				"warn",
				"adb not found (Android profiling unavailable)",
				"install platform-tools or set ANDROID_HOME"
			)
		: check("adb", "ok", version);
}

function traceProcessorCheck(ctx: CommandContext): DoctorCheck {
	let names: string[] = [];
	try {
		names = readdirSync(join(wardenHome(ctx.env), "tools"));
	} catch {
		// no tools dir yet
	}
	const cached = names.find((n) => n.startsWith("trace_processor_shell-"));
	return cached === undefined
		? check(
				"trace-processor",
				"warn",
				"not cached (needed for Android --native analysis)",
				"warden perf tools install trace-processor"
			)
		: check(
				"trace-processor",
				"ok",
				cached.slice("trace_processor_shell-".length)
					? `cached ${cached.slice("trace_processor_shell-".length)}`
					: "cached"
			);
}

async function deviceToolsCheck(
	ctx: CommandContext,
	device: PerfTarget | undefined,
	why: string
): Promise<DoctorCheck> {
	if (device === undefined) return check("device-tools", "skip", why);
	if (device.platform !== "android") return check("device-tools", "skip", "iOS simulator (xctrace runs on the host)");
	const res = await ctx.exec(
		[androidTools(ctx.env).adb, "-s", device.udid, "shell", "which", "perfetto", "simpleperf"],
		{
			timeoutMs: 10_000,
		}
	);
	const tools = parseDeviceTools(res.stdout);
	const present = Object.entries(tools).flatMap(([name, has]) => (has ? [name] : []));
	const missing = Object.entries(tools).flatMap(([name, has]) => (has ? [] : [name]));
	if (missing.length === 0) return check("device-tools", "ok", present.join(", "));
	return check(
		"device-tools",
		"warn",
		`${present.join(", ") || "none"} on device`,
		`missing ${missing.join(", ")}: use an Android 9+ image (perfetto) / a userdebug or Play-less image (simpleperf)`
	);
}

async function appCheck(
	ctx: CommandContext,
	device: PerfTarget | undefined,
	flag: string | undefined,
	why: string
): Promise<DoctorCheck> {
	if (device === undefined) return check("app", "skip", why);
	const app = await resolveApp(ctx, { platform: device.platform, id: device.udid }, flag);
	if (!app.success) return check("app", "warn", app.error.message, app.error.hint);
	if (device.platform === "ios") return check("app", "ok", `${app.data.id} (${app.data.source})`);
	const res = await ctx.exec(
		[androidTools(ctx.env).adb, "-s", device.udid, "shell", "dumpsys", "package", app.data.id],
		{
			timeoutMs: 15_000,
		}
	);
	if (res.exitCode !== 0) return check("app", "warn", `${app.data.id}: dumpsys package failed`);
	const flags = parsePackageFlags(res.stdout);
	if (flags.debuggable || flags.profileable) {
		return check("app", "ok", `${app.data.id} (${flags.debuggable ? "debuggable" : "profileable"})`);
	}
	return check(
		"app",
		"warn",
		`${app.data.id} is neither debuggable nor profileable`,
		'add <profileable android:shell="true"/> inside <application> in AndroidManifest.xml (release builds)'
	);
}

async function metroCheck(ctx: CommandContext, deps: PerfDeps, device: PerfTarget | undefined): Promise<DoctorCheck> {
	const url = await deps.host.metro(ctx, device?.udid);
	return url === undefined
		? check(
				"metro",
				"warn",
				"no Metro found (JS and React profiling need a dev client on Metro)",
				"warden dev <platform>"
			)
		: check("metro", "ok", url);
}

function line(ctx: CommandContext, c: DoctorCheck): string[] {
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
export async function perfDoctor(ctx: CommandContext, deps: PerfDeps, opts: PerfOptionValues): Promise<number> {
	const resolved = await resolvePerfDevice(ctx, opts, "observe", deps.device);
	const device = resolved.success ? resolved.data : undefined;
	const why = resolved.success ? "" : resolved.error.message;
	const checks: DoctorCheck[] = [
		await xctraceCheck(ctx, deps),
		await xcodeCheck(ctx, deps),
		await instrumentsCheck(ctx, deps),
		await adbCheck(ctx),
		await deviceToolsCheck(ctx, device, why),
		traceProcessorCheck(ctx),
		await metroCheck(ctx, deps, device),
		await appCheck(ctx, device, opts.app, why),
	];
	const ok = checks.every((c) => c.status !== "fail");
	const info = device && { udid: device.udid, platform: device.platform, name: device.name };
	const header = info ? `${info.udid} ${info.name ?? ""} (${info.platform})`.trim() : `no device: ${why}`;
	const text = [ctx.ui.color.dim(header), ...checks.flatMap((c) => line(ctx, c))].join("\n");
	emit(ctx, opts.json === true, { ok, ...(info ? { device: info } : {}), checks }, text, { scope: "perf doctor" });
	return ok ? 0 : 1;
}

/** Wire `doctor` onto `warden perf`. */
export function registerDoctor(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: PerfDeps
): void {
	withPerfOptions(
		cmd
			.command("doctor")
			.description(
				"what profiling needs: xctrace / Xcode, adb + device tools, trace_processor, Metro, a profileable app"
			)
	).action(async (opts) => {
		done(await perfDoctor(ctx, deps, opts));
	});
}
