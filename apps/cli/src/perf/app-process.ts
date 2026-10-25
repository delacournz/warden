import { androidTools } from "@delacour/warden-core/providers/android";
import type { Platform } from "@delacour/warden-core/types";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";

type DeviceRef = { platform: Platform; id: string };

/** An installed iOS app: its `.app` bundle on the host and the executable inside it (what `ps` shows). */
export type IosAppBundle = { appPath: string; executable: string; executablePath: string };

/** `simctl get_app_container <udid> <bundle> app` + the bundle's `CFBundleExecutable`. */
export async function iosAppBundle(
	ctx: CommandContext,
	udid: string,
	bundleId: string
): Promise<Result<IosAppBundle, UiError>> {
	const container = await ctx.exec(["xcrun", "simctl", "get_app_container", udid, bundleId, "app"], {
		timeoutMs: 10_000,
	});
	const appPath = container.stdout.trim();
	if (container.exitCode !== 0 || appPath === "") {
		return {
			success: false,
			error: uiError("app_not_found", `${bundleId} is not installed on ${udid}`, {
				hint: "install the app (warden dev ios) or pass --app <bundleId>",
			}),
		};
	}
	const plist = await ctx.exec(
		["plutil", "-extract", "CFBundleExecutable", "raw", "-o", "-", `${appPath}/Info.plist`],
		{ timeoutMs: 5_000 }
	);
	const executable = plist.stdout.trim();
	if (plist.exitCode !== 0 || executable === "") {
		return {
			success: false,
			error: uiError("app_not_found", `no CFBundleExecutable in ${appPath}/Info.plist`),
		};
	}
	return ok({ appPath, executable, executablePath: `${appPath}/${executable}` });
}

/** `launchctl list` row of a running app: `<pid>  <status>  UIKitApplication:<bundle>[0x…]…` (`-` = not running). */
function iosPidFrom(launchctl: string, bundleId: string): number | undefined {
	const prefix = `UIKitApplication:${bundleId}[`;
	for (const line of launchctl.split("\n")) {
		const [pid, , label] = line.trim().split(/\s+/);
		if (label?.startsWith(prefix) && pid !== undefined && /^\d+$/.test(pid)) return Number(pid);
	}
	return undefined;
}

/** The app's running pid on the device, or undefined when it is not running. */
export async function appPid(ctx: CommandContext, device: DeviceRef, appId: string): Promise<number | undefined> {
	if (device.platform === "android") {
		const res = await ctx.exec([androidTools(ctx.env).adb, "-s", device.id, "shell", "pidof", appId], {
			timeoutMs: 5_000,
		});
		const pid = res.stdout.trim().split(/\s+/)[0];
		return res.exitCode === 0 && pid !== undefined && /^\d+$/.test(pid) ? Number(pid) : undefined;
	}
	const res = await ctx.exec(["xcrun", "simctl", "spawn", device.id, "launchctl", "list"], { timeoutMs: 10_000 });
	return res.exitCode === 0 ? iosPidFrom(res.stdout, appId) : undefined;
}
