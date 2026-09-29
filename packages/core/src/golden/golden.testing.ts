import type { Exec, ExecResult } from "../exec";
import { SIMCTL_DEVICETYPES_JSON, SIMCTL_RUNTIMES_JSON } from "../providers/ios.fixture";

export const RUNTIME_ID = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
export const RUNTIME_BUILD = "23F77";
export const IPHONE_17 = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";

export type FakeSim = {
	udid: string;
	name: string;
	state: "Booted" | "Shutdown";
	isAvailable?: boolean;
	runtimeId?: string;
};

export type FakeHost = {
	sims: FakeSim[];
	calls: string[][];
	/** plutil polls per udid before its migration record appears (Infinity = never) */
	migrationPolls: number;
	/** %CPU samples returned for a booted sim, in order (last repeats) */
	cpu: number[];
	/** clone of a booted source fails like simctl does */
	exec: Exec;
};

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ exitCode: 1, stdout: "", stderr });

/** Stateful fake of `xcrun simctl`, `xcodebuild`, `plutil`, `launchctl`, `ps` for golden tests. */
export function fakeHost(init: Partial<Pick<FakeHost, "sims" | "migrationPolls" | "cpu">> = {}): FakeHost {
	let next = 1;
	const polls = new Map<string, number>();
	let cpuIndex = 0;
	const host: FakeHost = {
		sims: init.sims ?? [],
		calls: [],
		migrationPolls: init.migrationPolls ?? 1,
		cpu: init.cpu ?? [10],
		exec: async (cmd) => {
			host.calls.push([...cmd]);
			const find = (udid: string | undefined) => host.sims.find((s) => s.udid === udid);
			const [bin, ...rest] = cmd;
			if (bin === "xcodebuild") return ok("Xcode 26.6\nBuild version 17F113\n");
			if (bin === "plutil") {
				const path = rest[rest.length - 1] ?? "";
				const udid = /Devices\/([^/]+)\/data/.exec(path)?.[1] ?? "";
				const seen = (polls.get(udid) ?? 0) + 1;
				polls.set(udid, seen);
				return seen > host.migrationPolls
					? ok(JSON.stringify({ DMLastMigrationResults: { buildVersion: RUNTIME_BUILD, success: true } }))
					: ok(JSON.stringify({ DMUserDataDisposition: 1 }));
			}
			if (bin === "launchctl") {
				return ok(
					host.sims
						.filter((s) => s.state === "Booted")
						.map((s, i) => `${900 + i}\t0\tcom.apple.CoreSimulator.SimDevice.${s.udid}`)
						.join("\n")
				);
			}
			if (bin === "ps") {
				const cpu = host.cpu[Math.min(cpuIndex++, host.cpu.length - 1)] ?? 0;
				return ok(`  900 ${cpu}\n    1 99\n`);
			}
			if (bin !== "xcrun" || rest[0] !== "simctl") return fail(`unexpected ${cmd.join(" ")}`);
			const [, verb, ...args] = rest;
			switch (verb) {
				case "list":
					if (args[0] === "devicetypes") return ok(SIMCTL_DEVICETYPES_JSON);
					if (args[0] === "runtimes") return ok(SIMCTL_RUNTIMES_JSON);
					return ok(
						JSON.stringify({
							devices: {
								[RUNTIME_ID]: host.sims.map((s) => ({
									udid: s.udid,
									name: s.name,
									state: s.state,
									isAvailable: s.isAvailable ?? true,
									deviceTypeIdentifier: IPHONE_17,
								})),
							},
						})
					);
				case "create": {
					const udid = `NEW-${next++}`;
					host.sims.push({ udid, name: args[0] ?? "", state: "Shutdown" });
					return ok(`${udid}\n`);
				}
				case "clone": {
					const src = find(args[0]);
					if (!src) return fail("Invalid device");
					if (src.state === "Booted") return fail("Unable to clone device in current state: Booted");
					const udid = `CLONE-${next++}`;
					host.sims.push({ udid, name: args[1] ?? "", state: "Shutdown" });
					return ok(`${udid}\n`);
				}
				case "boot": {
					const sim = find(args[0]);
					if (sim) sim.state = "Booted";
					return ok();
				}
				case "shutdown": {
					const sim = find(args[0]);
					if (sim) sim.state = "Shutdown";
					return ok();
				}
				case "bootstatus":
					return ok();
				case "rename": {
					const sim = find(args[0]);
					if (sim) sim.name = args[1] ?? sim.name;
					return ok();
				}
				case "delete":
					host.sims = host.sims.filter((s) => s.udid !== args[0]);
					return ok();
				default:
					return fail(`unexpected simctl ${verb}`);
			}
		},
	};
	return host;
}
