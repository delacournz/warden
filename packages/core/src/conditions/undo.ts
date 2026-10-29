import { ok, type Result } from "@delacour/warden-types/result";
import { PENDING_PREFIX } from "../claim";
import { type Exec, execError } from "../exec";
import type { PidAlive } from "../liveness";
import { androidTools } from "../providers/android";
import type { Store } from "../store";
import type { Lease, Platform } from "../types";
import { activeConditions, clearCondition } from "./conditions";
import type { ConditionArea, ConditionRecord } from "./conditions.types";

export type UndoDeps = {
	store: Store;
	exec: Exec;
	env: Record<string, string | undefined>;
	now: () => number;
	pidAlive: PidAlive;
	/** SIGTERM an owned process */
	kill: (pid: number) => void;
	/** stop the lease's shaping proxy, free its port lease and handle file (`releaseLeaseProxy`); injected so undo stays pure */
	releaseProxy?: (leaseId: string) => Promise<boolean>;
};

export type UndoReport = { reset: ConditionArea[]; killed: number[] };

/** `errors`: one line per failed reset; `report`: what did get undone. */
export type UndoFailure = { errors: string[]; report: UndoReport };

/** Reset commands for one active area on one platform; an area with no device-side state has none. */
function resetCommands(
	platform: Platform,
	serial: string,
	record: ConditionRecord,
	deps: Pick<UndoDeps, "env" | "now">
): string[][] {
	if (platform === "ios") {
		switch (record.area) {
			case "location":
				return [["xcrun", "simctl", "location", serial, "clear"]];
			case "permission":
				return [["xcrun", "simctl", "privacy", serial, "reset", "all"]];
			default:
				return [];
		}
	}
	const { adb } = androidTools(deps.env);
	const base = [adb, "-s", serial];
	switch (record.area) {
		case "network":
			return [
				[...base, "emu", "network", "speed", "full"],
				[...base, "emu", "network", "delay", "none"],
				[...base, "shell", "cmd", "connectivity", "airplane-mode", "disable"],
				[...base, "shell", "settings", "put", "global", "http_proxy", ":0"],
			];
		case "clock":
			return [
				[...base, "shell", "settings", "put", "global", "auto_time", "1"],
				[...base, "shell", "cmd", "alarm", "set-time", String(deps.now())],
			];
		case "permission":
			return [[...base, "shell", "pm", "reset-permissions"]];
		case "a11y":
			return [[...base, "shell", "settings", "put", "system", "font_scale", "1.0"]];
		case "battery":
			return [[...base, "shell", "dumpsys", "battery", "reset"]];
		default:
			return [];
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Run reset commands in order; one failure line per command that exited non-zero or threw. */
async function runResets(exec: Exec, cmds: readonly string[][]): Promise<string[]> {
	const failures: string[] = [];
	for (const cmd of cmds) {
		try {
			const result = await exec(cmd);
			if (result.exitCode !== 0) failures.push(execError(cmd, result));
		} catch (error) {
			failures.push(`${cmd.join(" ")}: ${message(error)}`);
		}
	}
	return failures;
}

/** Network area: let the injected releaser stop the proxy and free its port; a throw is a failure line. */
async function releaseProxy(deps: UndoDeps, leaseId: string, record: ConditionRecord): Promise<string[]> {
	if (record.area !== "network" || !deps.releaseProxy) return [];
	try {
		await deps.releaseProxy(leaseId);
		return [];
	} catch (error) {
		return [`release proxy: ${message(error)}`];
	}
}

/** SIGTERM the live processes `record` owns; a dead pid is skipped (already gone). */
function stopOwned(deps: UndoDeps, record: ConditionRecord): { killed: number[]; failures: string[] } {
	const out = { killed: [] as number[], failures: [] as string[] };
	for (const { pid } of record.owned) {
		if (!deps.pidAlive(pid)) continue;
		try {
			deps.kill(pid);
			out.killed.push(pid);
		} catch (error) {
			out.failures.push(`kill ${pid}: ${message(error)}`);
		}
	}
	return out;
}

/**
 * Undo every condition `lease` has set on its device: reset commands per active area, owned processes
 * killed, then the row cleared. Only the lease's own device is touched (a non-device or still-pending
 * lease has none to reset). Idempotent — an area with no row costs nothing — and never throws: a reset
 * that fails keeps its row, is reported, and leaves the other areas to run.
 */
export async function undoConditions(deps: UndoDeps, lease: Lease): Promise<Result<UndoReport, UndoFailure>> {
	const report: UndoReport = { reset: [], killed: [] };
	const errors: string[] = [];
	const target = lease.resource;
	const device = target.kind === "device" && !target.id.startsWith(PENDING_PREFIX) ? target : undefined;
	for (const record of activeConditions(deps.store, lease.id)) {
		const cmds = device ? resetCommands(device.platform, device.id, record, deps) : [];
		const resets = await runResets(deps.exec, cmds);
		const released = await releaseProxy(deps, lease.id, record);
		const stopped = stopOwned(deps, record);
		report.killed.push(...stopped.killed);
		const failures = [...resets, ...released, ...stopped.failures];
		if (failures.length > 0) {
			errors.push(...failures.map((f) => `${record.area}: ${f}`));
			continue;
		}
		clearCondition(deps.store, lease.id, record.area);
		report.reset.push(record.area);
	}
	return errors.length > 0 ? { success: false, error: { errors, report } } : ok(report);
}
