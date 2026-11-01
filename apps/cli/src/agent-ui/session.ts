import type { OpDone, OpSession } from "@delacour/warden-sdk/ops/session";
import { storeLocator } from "@delacour/warden-store/store";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { UiDevice } from "./device";
import type { UiDeps } from "./driver";
import type { UiExitCode, UiSuccess } from "./output";
import { recorderFor, routeAfterFor } from "./record";
import type { UiRunEnv } from "./run";
import { createFileRefStore, createFileStateStore } from "./state-stores";

/** The parts of an {@link OpSession} only some subcommands set (devtools, ports, authoring). */
export type SessionExtras = Pick<OpSession, "devtools" | "ports" | "authoring">;

/**
 * The SDK op session behind one `warden ui` call: this device, the process-wide clock/exec, the file-backed ref and
 * state stores (so `@eN` refs and recordings carry across `warden ui` processes), and the spec-authoring recorder
 * (with its route capture) unless the call said `--no-record`.
 */
export function opSessionFor(
	ctx: CommandContext,
	deps: UiDeps,
	device: UiDevice,
	env: UiRunEnv,
	extras: SessionExtras = {}
): OpSession {
	const refs = createFileRefStore(ctx, device.udid);
	const state = createFileStateStore(ctx, device.udid);
	const host = {
		env: ctx.env,
		cwd: ctx.cwd,
		home: storeLocator.wardenHome(ctx.env),
		now: ctx.now,
		exec: ctx.exec,
		sleep: deps.sleep,
	};
	return {
		device: { id: device.udid, platform: device.platform, ...(device.name !== undefined ? { name: device.name } : {}) },
		host,
		driver: env.driver,
		refs,
		state,
		timeoutMs: env.timeoutMs,
		...(env.record
			? { recorder: recorderFor(ctx, deps, { state, refs }), routeAfter: routeAfterFor(ctx, deps, env, device, state) }
			: {}),
		...(deps.video ? { video: deps.video } : {}),
		...extras,
	};
}

/** An op's outcome as the `runUi` work function returns it: the op's result with this device's identity attached. */
export function reply<R>(device: UiDevice, outcome: Result<OpDone<R>, WardenError>): Result<UiSuccess, WardenError> {
	if (!outcome.success) return outcome;
	const { result, text, generation, warnings, exit } = outcome.data;
	return resultFactory.ok({
		device: { udid: device.udid, platform: device.platform, name: device.name },
		result,
		text,
		...(generation !== undefined ? { generation } : {}),
		...(warnings !== undefined ? { warnings } : {}),
		...(exit !== undefined ? { exit: exit satisfies UiExitCode } : {}),
	});
}
