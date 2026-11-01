import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { liveness, type PidAlive } from "@delacour/warden-store/liveness";
import type { CommandContext } from "../context";
import { cliUiPaths } from "./paths";

type Host = Pick<CommandContext, "env" | "now">;

/** The `state.json` fields that record a resident helper: iOS's `warden-simd`, Android's host, a physical iPhone's runner host. */
type HelperField = "helper" | "androidHost" | "iosRunner";

export type SweepDeps = {
	pidAlive?: PidAlive;
	/** loads `helper.ts`; tests count loads */
	load?: () => Promise<{ uiHelper: typeof import("./helper").uiHelper }>;
};

export class UiHelperSweep {
	/** The pid of the helper `state.json` records under `field`, read as plain JSON: any other shape is no record. */
	private recordedPid(
		host: Pick<CommandContext, "env">,
		udid: string,
		field: HelperField = "helper"
	): number | undefined {
		try {
			const state: unknown = JSON.parse(readFileSync(join(cliUiPaths.uiDir(host, udid), "state.json"), "utf8"));
			if (typeof state !== "object" || state === null || !(field in state)) return undefined;
			const record: unknown = Reflect.get(state, field);
			if (typeof record !== "object" || record === null || !("pid" in record)) return undefined;
			return typeof record.pid === "number" ? record.pid : undefined;
		} catch {
			return undefined;
		}
	}

	/** Every device that has a socket under `simd/` or a dir under `ui/` (plain directory reads). */
	knownUdids(host: Pick<CommandContext, "env">): string[] {
		const udids = new Set<string>();
		for (const sockets of [cliUiPaths.simdDir(host), cliUiPaths.androidHostDir(host), cliUiPaths.iosRunnerDir(host)]) {
			if (!existsSync(sockets)) continue;
			for (const name of readdirSync(sockets)) if (name.endsWith(".sock")) udids.add(basename(name, ".sock"));
		}
		const root = cliUiPaths.uiRoot(host);
		if (existsSync(root)) for (const name of readdirSync(root)) udids.add(name);
		return [...udids];
	}

	/** Devices whose `state.json` records a helper pid that no longer runs (plain file reads: no schema, no driver). */
	findDeadHelpers(host: Pick<CommandContext, "env">, pidAlive: PidAlive = liveness.processAlive): string[] {
		return this.knownUdids(host).filter((udid) =>
			(["helper", "androidHost", "iosRunner"] as const).some((field) => {
				const pid = this.recordedPid(host, udid, field);
				return pid !== undefined && !pidAlive(pid);
			})
		);
	}

	/**
	 * `sweepDeadHelpers` for commands that must start fast (`gc`): the records are looked at first, and `./helper`
	 * (the e2e iOS driver, its wire schemas and zod) is imported only when one names a helper that is gone.
	 */
	async sweepDeadHelpersLazily(host: Host, deps: SweepDeps = {}): Promise<string[]> {
		const pidAlive = deps.pidAlive ?? liveness.processAlive;
		if (this.findDeadHelpers(host, pidAlive).length === 0) return [];
		const { uiHelper } = await (deps.load ?? (() => import("./helper")))();
		return uiHelper.sweepDeadHelpers(host, { pidAlive });
	}

	/**
	 * Stop the resident Android host of each serial that has one recorded, before something else drives the emulator
	 * (a `warden batch` / `warden e2e` job opens its own driver, and two `warden-uiad` clients evict each other). Records
	 * are read as plain JSON; `./helper` is imported only when one exists, so a run with no host loads nothing.
	 */
	async stopAndroidHostsLazily(
		host: Host & Partial<Pick<CommandContext, "store">>,
		serials: readonly string[],
		deps: { load?: () => Promise<{ uiHelper: Pick<typeof import("./helper").uiHelper, "stopAndroidHost"> }> } = {}
	): Promise<string[]> {
		const recorded = serials.filter((serial) => this.recordedPid(host, serial, "androidHost") !== undefined);
		if (recorded.length === 0) return [];
		const { uiHelper } = await (deps.load ?? (() => import("./helper")))();
		const warnings: string[] = [];
		for (const serial of recorded) {
			const { warning } = await uiHelper.stopAndroidHost(host, serial);
			if (warning !== undefined) warnings.push(warning);
		}
		return warnings;
	}

	/**
	 * Stop the resident iPhone runner host of each physical UDID that has one recorded, before something else drives the
	 * phone (two `xcodebuild` runner sessions on one device evict each other). Same shape as `stopAndroidHostsLazily`:
	 * plain-JSON record check first, `./helper` imported only when one exists.
	 */
	async stopIosRunnersLazily(
		host: Host & Partial<Pick<CommandContext, "store">>,
		udids: readonly string[],
		deps: { load?: () => Promise<{ uiHelper: Pick<typeof import("./helper").uiHelper, "stopIosRunner"> }> } = {}
	): Promise<string[]> {
		const recorded = udids.filter((udid) => this.recordedPid(host, udid, "iosRunner") !== undefined);
		if (recorded.length === 0) return [];
		const { uiHelper } = await (deps.load ?? (() => import("./helper")))();
		const warnings: string[] = [];
		for (const udid of recorded) {
			const { warning } = await uiHelper.stopIosRunner(host, udid);
			if (warning !== undefined) warnings.push(warning);
		}
		return warnings;
	}
}

export const uiHelperSweep = new UiHelperSweep();
