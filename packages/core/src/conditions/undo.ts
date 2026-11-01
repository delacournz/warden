import type { ConditionArea, ConditionRecord } from "@delacour/warden-config/conditions.types";
import { PENDING_PREFIX } from "@delacour/warden-leasing/claim";
import { androidToolsLocator } from "@delacour/warden-providers/android-tools";
import { type Exec, execErrors } from "@delacour/warden-runtime/exec";
import type { PidAlive } from "@delacour/warden-store/liveness";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import type { Lease, Platform } from "@delacour/warden-store/types";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { leaseConditions } from "./conditions";
import { injectState } from "./inject-state";
import { launchSettingsFile } from "./launch-settings";

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
	/** the host's timezone, for an Android timezone whose previous value was not recorded (default: `Intl`) */
	hostTimezone?: () => string;
};

export type UndoReport = { reset: ConditionArea[]; killed: number[] };

/** `errors`: one line per failed reset; `report`: what did get undone. */
export type UndoFailure = { errors: string[]; report: UndoReport };

/** What resetting one condition record did: failure lines (empty = reset) and the owned pids stopped. */
export type ResetOutcome = { failures: string[]; killed: number[] };

type DeviceTarget = { platform: Platform; id: string };

export class ConditionUndo {
	constructor(private readonly deps: UndoDeps) {}

	/**
	 * Reset one condition record on `device` (undefined = nothing on a device to reset): the area's reset
	 * commands, the iOS inject-state / launch-settings cleanup, the lease's shaping proxy (`leaseId` keys its
	 * handle file) and the processes the record owns. Shared by a live lease's undo and an orphan's.
	 */
	async resetRecord(device: DeviceTarget | undefined, leaseId: string, record: ConditionRecord): Promise<ResetOutcome> {
		const { deps } = this;
		const cmds = device ? this.resetCommands(device.platform, device.id, record) : [];
		const resets = await this.runResets(cmds);
		// an injected iOS app that is still running keeps reading its state file: put it back online on the real clock
		if (device?.platform === "ios" && (record.area === "clock" || record.area === "network")) {
			const failed = injectState.neutralize(injectState.path(storeLocator.wardenHome(deps.env), device.id));
			if (failed) resets.push(failed);
		}
		// iOS has no device-side timezone or locale: only the staged launch settings go
		if (device?.platform === "ios" && record.area === "locale") {
			const failed = launchSettingsFile.write(
				launchSettingsFile.path(storeLocator.wardenHome(deps.env), device.id),
				{}
			);
			if (failed) resets.push(failed);
		}
		const released = await this.releaseNetworkProxy(leaseId, record);
		const stopped = this.stopOwned(record);
		return { failures: [...resets, ...released, ...stopped.failures], killed: stopped.killed };
	}

	/**
	 * Undo every condition `lease` has set on its device: reset commands per active area, owned processes
	 * killed, then the row cleared. Only the lease's own device is touched (a non-device or still-pending
	 * lease has none to reset). Idempotent — an area with no row costs nothing — and never throws: a reset
	 * that fails keeps its row, is reported, and leaves the other areas to run.
	 */
	async undo(lease: Lease): Promise<Result<UndoReport, UndoFailure>> {
		const { deps } = this;
		const report: UndoReport = { reset: [], killed: [] };
		const errors: string[] = [];
		const target = lease.resource;
		const device = target.kind === "device" && !target.id.startsWith(PENDING_PREFIX) ? target : undefined;
		for (const record of leaseConditions.active(deps.store, lease.id)) {
			const { failures, killed } = await this.resetRecord(device, lease.id, record);
			report.killed.push(...killed);
			if (failures.length > 0) {
				errors.push(...failures.map((f) => `${record.area}: ${f}`));
				continue;
			}
			leaseConditions.clear(deps.store, lease.id, record.area);
			report.reset.push(record.area);
		}
		return errors.length > 0 ? { success: false, error: { errors, report } } : resultFactory.ok(report);
	}

	/** Reset commands for one active area on one platform; an area with no device-side state has none. */
	private resetCommands(platform: Platform, serial: string, record: ConditionRecord): string[][] {
		if (platform === "ios") return this.iosResets(serial, record);
		const { adb } = androidToolsLocator.locate(this.deps.env);
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
					[...base, "shell", "cmd", "alarm", "set-time", String(this.deps.now())],
				];
			case "permission":
				return [[...base, "shell", "pm", "reset-permissions"]];
			case "a11y":
				return [
					[...base, "shell", "settings", "put", "system", "font_scale", "1.0"],
					[...base, "shell", "settings", "put", "secure", "font_weight_adjustment", "0"],
				];
			case "locale":
				return this.androidLocaleResets(base, record);
			case "battery":
				return [[...base, "shell", "dumpsys", "battery", "reset"]];
			default:
				return [];
		}
	}

	private iosResets(serial: string, record: ConditionRecord): string[][] {
		switch (record.area) {
			case "location":
				return [["xcrun", "simctl", "location", serial, "clear"]];
			case "permission":
				return [["xcrun", "simctl", "privacy", serial, "reset", "all"]];
			case "a11y":
				return [
					["xcrun", "simctl", "ui", serial, "content_size", "large"],
					["xcrun", "simctl", "ui", serial, "increase_contrast", "disabled"],
				];
			case "battery":
				return [["xcrun", "simctl", "status_bar", serial, "clear"]];
			default:
				return [];
		}
	}

	/** Android: the timezone back to what it was (or the host's), and the app's locale override removed. */
	private androidLocaleResets(
		base: readonly string[],
		record: Extract<ConditionRecord, { area: "locale" }>
	): string[][] {
		const cmds: string[][] = [];
		const { timezone, previousTimezone, locale, bundleId } = record.value;
		if (timezone !== undefined) {
			const host = this.deps.hostTimezone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
			cmds.push([...base, "shell", "cmd", "alarm", "set-timezone", previousTimezone ?? host]);
		}
		if (locale !== undefined && bundleId !== undefined) {
			cmds.push([...base, "shell", "cmd", "locale", "set-app-locales", bundleId, "--locales", "''"]);
		}
		return cmds;
	}

	private message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	/** Run reset commands in order; one failure line per command that exited non-zero or threw. */
	private async runResets(cmds: readonly string[][]): Promise<string[]> {
		const failures: string[] = [];
		for (const cmd of cmds) {
			try {
				const result = await this.deps.exec(cmd);
				if (result.exitCode !== 0) failures.push(execErrors.format(cmd, result));
			} catch (error) {
				failures.push(`${cmd.join(" ")}: ${this.message(error)}`);
			}
		}
		return failures;
	}

	/** Network area: let the injected releaser stop the proxy and free its port; a throw is a failure line. */
	private async releaseNetworkProxy(leaseId: string, record: ConditionRecord): Promise<string[]> {
		const { deps } = this;
		if (record.area !== "network" || !deps.releaseProxy) return [];
		try {
			await deps.releaseProxy(leaseId);
			return [];
		} catch (error) {
			return [`release proxy: ${this.message(error)}`];
		}
	}

	/** SIGTERM the live processes `record` owns; a dead pid is skipped (already gone). */
	private stopOwned(record: ConditionRecord): { killed: number[]; failures: string[] } {
		const out = { killed: [] as number[], failures: [] as string[] };
		for (const { pid } of record.owned) {
			if (!this.deps.pidAlive(pid)) continue;
			try {
				this.deps.kill(pid);
				out.killed.push(pid);
			} catch (error) {
				out.failures.push(`kill ${pid}: ${this.message(error)}`);
			}
		}
		return out;
	}
}
