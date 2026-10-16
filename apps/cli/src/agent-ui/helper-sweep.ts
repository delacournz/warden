import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type PidAlive, processAlive } from "@delacour/warden-core/liveness";
import type { CommandContext } from "../context";
import { simdDir, uiDir, uiRoot } from "./paths";

type Host = Pick<CommandContext, "env" | "now">;

/** The pid of the helper `state.json` records, read as plain JSON: any other shape is no record. */
function recordedPid(host: Pick<CommandContext, "env">, udid: string): number | undefined {
	try {
		const state: unknown = JSON.parse(readFileSync(join(uiDir(host, udid), "state.json"), "utf8"));
		if (typeof state !== "object" || state === null || !("helper" in state)) return undefined;
		const { helper } = state;
		if (typeof helper !== "object" || helper === null || !("pid" in helper)) return undefined;
		return typeof helper.pid === "number" ? helper.pid : undefined;
	} catch {
		return undefined;
	}
}

/** Every device that has a socket under `simd/` or a dir under `ui/`. */
export function knownUdids(host: Pick<CommandContext, "env">): string[] {
	const udids = new Set<string>();
	const sockets = simdDir(host);
	if (existsSync(sockets)) {
		for (const name of readdirSync(sockets)) if (name.endsWith(".sock")) udids.add(basename(name, ".sock"));
	}
	const root = uiRoot(host);
	if (existsSync(root)) for (const name of readdirSync(root)) udids.add(name);
	return [...udids];
}

/** Devices whose `state.json` records a helper pid that no longer runs (plain file reads: no schema, no driver). */
export function findDeadHelpers(host: Pick<CommandContext, "env">, pidAlive: PidAlive = processAlive): string[] {
	return knownUdids(host).filter((udid) => {
		const pid = recordedPid(host, udid);
		return pid !== undefined && !pidAlive(pid);
	});
}

export type SweepDeps = {
	pidAlive?: PidAlive;
	/** loads `helper.ts`; tests count loads */
	load?: () => Promise<typeof import("./helper")>;
};

/**
 * `sweepDeadHelpers` for commands that must start fast (`gc`): the records are looked at first, and `./helper`
 * (the e2e iOS driver, its wire schemas and zod) is imported only when one names a helper that is gone.
 */
export async function sweepDeadHelpersLazily(host: Host, deps: SweepDeps = {}): Promise<string[]> {
	const pidAlive = deps.pidAlive ?? processAlive;
	if (findDeadHelpers(host, pidAlive).length === 0) return [];
	const { sweepDeadHelpers } = await (deps.load ?? (() => import("./helper")))();
	return sweepDeadHelpers(host, { pidAlive });
}
