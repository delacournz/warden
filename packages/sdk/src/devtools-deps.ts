import { closeSync, openSync } from "node:fs";
import { metroOwner } from "@delacour/warden-builds/metro";
import { devtoolsFacetOpener } from "@delacour/warden-devtools/facet";
import { liveness } from "@delacour/warden-store/liveness";
import { processCommand } from "@delacour/warden-store/process-identity";
import type { DevtoolsDeps } from "./ops/devtools";

/**
 * Real Metro / collector access for SDK sessions. The detached collector re-runs the `warden` binary (`WARDEN_BIN`
 * or `warden` on PATH), so devtools console / network capture needs the CLI installed; `eval`, `tree` and `reload`
 * do not spawn anything.
 */
export function defaultDevtoolsDeps(env: Record<string, string | undefined>): DevtoolsDeps {
	return {
		open: (options) => devtoolsFacetOpener.open(options),
		probe: async (host, port) => {
			const owner = await metroOwner(host.exec, port, host.cwd);
			if (owner.kind === "ours") return "ours";
			return owner.kind === "foreign" ? "foreign" : "none";
		},
		collector: {
			self: () => [env.WARDEN_BIN ?? "warden"],
			spawnDetached: ({ cmd, logPath }) => {
				const log = openSync(logPath, "a");
				try {
					const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: log, stderr: log, detached: true });
					proc.unref();
					return { pid: proc.pid };
				} finally {
					closeSync(log);
				}
			},
			kill: (pid, signal) => {
				try {
					process.kill(pid, signal);
				} catch {
					// already gone
				}
			},
			pidAlive: liveness.processAlive,
			command: processCommand,
		},
	};
}
