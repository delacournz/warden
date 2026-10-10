import type { Exec, ExecResult } from "@delacour/warden-core/exec";
import { type FixtureSim, simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import { fakeExec } from "./testing";

export const OWNER_ENV = { WARDEN_SESSION_ID: "me" };

/** Fake `xcrun simctl` for command tests: inventory from `sims`, boot/bootstatus/shutdown succeed. */
export function fakeSimctl(
	sims: FixtureSim[],
	calls: string[][] = [],
	extra: Array<[prefix: string, result: Partial<ExecResult>]> = []
): Exec {
	return fakeExec(
		[
			...extra,
			["xcrun simctl list devices available -j", { stdout: simctlDevicesJson({ "iOS-26-5": sims }) }],
			["xcrun simctl boot", {}],
			["xcrun simctl bootstatus", {}],
			["xcrun simctl shutdown", {}],
			["xcrun simctl spawn", { stdout: "PID\tStatus\tLabel\n412\t0\tUIKitApplication:com.apple.springboard[x]\n" }],
		],
		calls
	);
}

export function wardenSim(n: number, state: FixtureSim["state"] = "Shutdown"): FixtureSim {
	return { udid: `U${n}`, name: `warden-iphone-17-${n}`, state };
}
