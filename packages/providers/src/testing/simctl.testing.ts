import type { Exec, ExecResult } from "@delacour/warden-runtime/exec";
import { fakeExec } from "@delacour/warden-runtime/testing/exec.testing";
import { type FixtureSim, simctlFixtures } from "./ios.fixture";

export const OWNER_ENV = { WARDEN_SESSION_ID: "me" };

/** Fakes for `xcrun simctl` in command tests. */
export class SimctlFakes {
	/** Fake `xcrun simctl` for command tests: inventory from `sims`, boot/bootstatus/shutdown succeed. */
	build(
		sims: FixtureSim[],
		calls: string[][] = [],
		extra: Array<[prefix: string, result: Partial<ExecResult>]> = []
	): Exec {
		return fakeExec.build(
			[
				...extra,
				["xcrun simctl list devices available -j", { stdout: simctlFixtures.devicesJson({ "iOS-26-5": sims }) }],
				["xcrun simctl boot", {}],
				["xcrun simctl bootstatus", {}],
				["xcrun simctl shutdown", {}],
				["xcrun simctl spawn", { stdout: "PID\tStatus\tLabel\n412\t0\tUIKitApplication:com.apple.springboard[x]\n" }],
			],
			calls
		);
	}

	wardenSim(n: number, state: FixtureSim["state"] = "Shutdown"): FixtureSim {
		return { udid: `U${n}`, name: `warden-iphone-17-${n}`, state };
	}
}

export const simctlFakes = new SimctlFakes();
