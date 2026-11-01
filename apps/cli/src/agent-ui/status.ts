import { leaseConditions } from "@delacour/warden-core/conditions/conditions";
import { leaseModel } from "@delacour/warden-store/types";
import { resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { uiConditionText } from "./condition-text";
import type { UiDevice } from "./device";
import type { UiDeps } from "./driver";
import { ANDROID_HOST_KIND, defaultHelperDeps, type HelperKind, IOS_RUNNER_KIND, SIMD_KIND, uiHelper } from "./helper";
import { cliUiPaths } from "./paths";
import { type UiOptionValues, uiRun } from "./run";
import { uiStatePersistence } from "./state";

export class UiStatus {
	/** The resident helper a device has: the Android host, a physical iPhone's runner host, or `warden-simd`. */
	private helperKindOf(device: Pick<UiDevice, "platform" | "udid">): HelperKind {
		if (device.platform === "android") return ANDROID_HOST_KIND;
		return leaseModel.isPhysicalIosId(device.udid) ? IOS_RUNNER_KIND : SIMD_KIND;
	}

	/** `warden ui status`: the device, the caller's lease on it, the helper and the recording in progress. */
	uiStatus(ctx: CommandContext, deps: UiDeps, opts: UiOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "status", opts, async (device: UiDevice) => {
			const { lease } = device;
			const conditions = leaseConditions.active(ctx.store(), lease.id);
			const conditionsText = uiConditionText.conditionsLine(conditions);
			const result = {
				lease: {
					id: lease.id,
					action: device.action,
					source: device.source,
					owner: leaseModel.describeOwner(lease.owner),
					label: lease.label ?? null,
					ttlMs: lease.ttlMs,
					heartbeatAt: lease.heartbeatAt,
				},
				helper: uiHelper.helperStatus(ctx, device.udid, defaultHelperDeps, this.helperKindOf(device)),
				recording: await this.recordingOf(ctx, device.udid),
				conditions: conditions.map((record) => ({ area: record.area, value: record.value, setAt: record.setAt })),
			};
			const { color } = ctx.ui;
			const text = [
				`${color.bold(device.udid)} ${device.name ?? ""} ${color.dim(`(${device.platform})`)}`.trimEnd(),
				`lease     ${lease.id} ${color.dim(`${device.action}, ${leaseModel.describeOwner(lease.owner)}`)}`,
				`helper    ${this.helperLine(result.helper)}`,
				`recording ${result.recording === null ? "none" : `${result.recording.name} → ${result.recording.target} (${result.recording.steps ?? "?"} steps)`}`,
				...(conditionsText === undefined ? [] : [`conditions ${conditionsText}`]),
			].join("\n");
			return resultFactory.ok({
				device: { udid: device.udid, platform: device.platform, name: device.name },
				result,
				text,
			});
		});
	}

	/** The recording in progress: its name, where `record stop` writes it, and how many steps the journal holds. */
	private async recordingOf(
		ctx: CommandContext,
		udid: string
	): Promise<{ name: string; target: string; steps: number | null } | null> {
		const recording = uiStatePersistence.readState(ctx, udid).recording;
		if (!recording) return null;
		const { journalStore } = await import("@delacour/warden-e2e/authoring/journal");
		const journal = journalStore.readJournal(cliUiPaths.recordingFile(ctx, udid));
		const target =
			recording.target.kind === "spec" ? recording.target.path : `${recording.target.path}#${recording.target.fn}`;
		return { name: recording.name, target, steps: journal.success ? journal.data.steps.length : null };
	}

	private helperLine(helper: ReturnType<typeof uiHelper.helperStatus>): string {
		if (helper.running) return `running pid ${helper.pid} ${helper.socket}`;
		return helper.pid === null ? "not started" : `not running (last pid ${helper.pid})`;
	}
}

export const uiStatus = new UiStatus();
