import type { Owner } from "@delacour/warden-core/types";
import { OWNER_ENV } from "../simctl.testing";
import type { TestContext } from "../testing";
import type { BootedDevice } from "./device";
import type { PerfHostDeps } from "./host";
import type { PerfDeps } from "./run";
import type { SessionDeps } from "./session";

export type FakePerfDeps = PerfDeps & {
	session: SessionDeps & { alive: Set<number>; commands: Map<number, string>; killed: Array<[number, string]> };
};

/** Fake process table + booted devices for `warden perf` command tests. */
export function fakePerfDeps(
	booted: BootedDevice[],
	apps: Record<string, string> = {},
	host: Partial<PerfHostDeps> = {}
): FakePerfDeps {
	const alive = new Set<number>();
	const commands = new Map<number, string>();
	const killed: Array<[number, string]> = [];
	let n = 0;
	return {
		host: { platform: "darwin", metro: async () => undefined, ...host },
		device: {
			pidAlive: (pid) => alive.has(pid),
			booted: async () => booted,
			foregroundApp: async (_ctx, d) => apps[d.id],
		},
		session: {
			alive,
			commands,
			killed,
			pidAlive: (pid) => alive.has(pid),
			command: (pid) => commands.get(pid),
			kill: (pid, signal) => {
				killed.push([pid, signal]);
				alive.delete(pid);
			},
			random: () => (++n).toString(16).padStart(6, "0"),
		},
	};
}

export const ME: Owner = { kind: "agent", sessionId: "me", cwd: "/" };

/** Make the context act as agent `me` (the owner `OWNER_ENV` names). */
export function asMe(c: TestContext): void {
	c.env = { ...c.env, ...OWNER_ENV };
}
