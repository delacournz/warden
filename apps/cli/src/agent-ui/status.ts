import { describeOwner } from "@delacour/warden-core/types";
import { ok } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { UiDevice } from "./device";
import type { UiDeps } from "./driver";
import { helperStatus } from "./helper";
import { runUi, type UiOptionValues } from "./run";

/** `warden ui status`: the device, the caller's lease on it, and (placeholders until later issues) helper + recording. */
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
			recording: "none",
		};
		const { color } = ctx.ui;
		const text = [
			`${color.bold(device.udid)} ${device.name ?? ""} ${color.dim(`(${device.platform})`)}`.trimEnd(),
			`lease     ${lease.id} ${color.dim(`${device.action}, ${describeOwner(lease.owner)}`)}`,
			`helper    ${helperLine(result.helper)}`,
			`recording ${result.recording}`,
		].join("\n");
		return ok({ device: { udid: device.udid, platform: device.platform, name: device.name }, result, text });
	});
}

function helperLine(helper: ReturnType<typeof helperStatus>): string {
	if (helper.running) return `running pid ${helper.pid} ${helper.socket}`;
	return helper.pid === null ? "not started" : `not running (last pid ${helper.pid})`;
}
