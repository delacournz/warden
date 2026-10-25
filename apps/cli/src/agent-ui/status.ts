import { describeOwner } from "@delacour/warden-core/types";
import { ok } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { UiDevice } from "./device";
import type { UiDeps } from "./driver";
import { helperStatus } from "./helper";
import { recordingFile } from "./paths";
import { runUi, type UiOptionValues } from "./run";
import { readState } from "./state";

/** `warden ui status`: the device, the caller's lease on it, the helper and the recording in progress. */
export function uiStatus(ctx: CommandContext, deps: UiDeps, opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "status", opts, async (device: UiDevice) => {
		const { lease } = device;
		const result = {
			lease: {
				id: lease.id,
				action: device.action,
				source: device.source,
				owner: describeOwner(lease.owner),
				label: lease.label ?? null,
				ttlMs: lease.ttlMs,
				heartbeatAt: lease.heartbeatAt,
			},
			helper: helperStatus(ctx, device.udid),
			recording: await recordingOf(ctx, device.udid),
		};
		const { color } = ctx.ui;
		const text = [
			`${color.bold(device.udid)} ${device.name ?? ""} ${color.dim(`(${device.platform})`)}`.trimEnd(),
			`lease     ${lease.id} ${color.dim(`${device.action}, ${describeOwner(lease.owner)}`)}`,
			`helper    ${helperLine(result.helper)}`,
			`recording ${result.recording === null ? "none" : `${result.recording.name} → ${result.recording.target} (${result.recording.steps ?? "?"} steps)`}`,
		].join("\n");
		return ok({ device: { udid: device.udid, platform: device.platform, name: device.name }, result, text });
	});
}

/** The recording in progress: its name, where `record stop` writes it, and how many steps the journal holds. */
async function recordingOf(
	ctx: CommandContext,
	udid: string
): Promise<{ name: string; target: string; steps: number | null } | null> {
	const recording = readState(ctx, udid).recording;
	if (!recording) return null;
	const { readJournal } = await import("@delacour/warden-e2e/authoring/journal");
	const journal = readJournal(recordingFile(ctx, udid));
	const target =
		recording.target.kind === "spec" ? recording.target.path : `${recording.target.path}#${recording.target.fn}`;
	return { name: recording.name, target, steps: journal.success ? journal.data.steps.length : null };
}

function helperLine(helper: ReturnType<typeof helperStatus>): string {
	if (helper.running) return `running pid ${helper.pid} ${helper.socket}`;
	return helper.pid === null ? "not started" : `not running (last pid ${helper.pid})`;
}
