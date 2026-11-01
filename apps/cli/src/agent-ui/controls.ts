import type { BiometricOp } from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import { finishAction } from "@delacour/warden-sdk/ops/act";
import { alert, hardware, screenAppearance, screenRotate, screenshot } from "@delacour/warden-sdk/ops/controls";
import type { CommandContext } from "../context";
import { type ActionOptionValues, parseSettle } from "./args";
import { physicalDevice } from "./device";
import { fromDriver, type UiDeps } from "./driver";
import { uiError } from "./output";
import { runUi } from "./run";
import { opSessionFor, reply } from "./session";

/** `warden ui alert accept|dismiss|get`: answer the system alert / sheet on top, or read it. */
export function uiAlert(ctx: CommandContext, deps: UiDeps, what: string, opts: ActionOptionValues): Promise<number> {
	return runUi(ctx, deps, "alert", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		return reply(
			device,
			await alert(opSessionFor(ctx, deps, device, env), {
				action: what,
				...(settle.data !== undefined ? { settleMs: settle.data } : {}),
			})
		);
	});
}

/** `warden ui home` / `warden ui back` (Android only). */
export function uiHardware(
	ctx: CommandContext,
	deps: UiDeps,
	button: "home" | "back",
	opts: ActionOptionValues
): Promise<number> {
	return runUi(ctx, deps, button, opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		return reply(
			device,
			await hardware(opSessionFor(ctx, deps, device, env), {
				button,
				...(settle.data !== undefined ? { settleMs: settle.data } : {}),
			})
		);
	});
}

/** `warden ui screen rotate [orientation]`: set the orientation, or read it. */
export function uiRotate(
	ctx: CommandContext,
	deps: UiDeps,
	raw: string | undefined,
	opts: ActionOptionValues
): Promise<number> {
	return runUi(ctx, deps, "screen rotate", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		return reply(
			device,
			await screenRotate(opSessionFor(ctx, deps, device, env), {
				...(raw !== undefined ? { orientation: raw } : {}),
				...(settle.data !== undefined ? { settleMs: settle.data } : {}),
			})
		);
	});
}

/** `warden ui screen appearance [light|dark]`: set the appearance, or read it. */
export function uiAppearance(
	ctx: CommandContext,
	deps: UiDeps,
	raw: string | undefined,
	opts: ActionOptionValues
): Promise<number> {
	return runUi(ctx, deps, "screen appearance", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		return reply(
			device,
			await screenAppearance(opSessionFor(ctx, deps, device, env), {
				...(raw !== undefined ? { mode: raw } : {}),
				...(settle.data !== undefined ? { settleMs: settle.data } : {}),
			})
		);
	});
}

const BIOMETRIC_OPS: readonly BiometricOp[] = ["status", "enroll", "unenroll", "match", "fail"];

/** `warden ui biometrics [status|enroll|unenroll|match|fail]`: simulated Face ID / Touch ID / fingerprint; no op reads the state. */
export function uiBiometrics(
	ctx: CommandContext,
	deps: UiDeps,
	raw: string | undefined,
	opts: ActionOptionValues
): Promise<number> {
	return runUi(ctx, deps, "biometrics", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		const op = BIOMETRIC_OPS.find((candidate) => candidate === (raw ?? "status"));
		if (op === undefined) {
			return {
				success: false,
				error: uiError("usage", `unknown biometrics op "${raw}"`, { hint: BIOMETRIC_OPS.join(" | ") }),
			};
		}
		if (physicalDevice(device)) {
			const what = device.platform === "ios" ? "a physical iPhone" : "a physical Android device";
			return fromDriver(
				driverErrors.err(
					"E_UNSUPPORTED",
					`biometrics is not available on ${what}: a real Face ID / fingerprint sensor is never enrolled or matched; use a simulator or emulator`
				)
			);
		}
		const driver = await env.driver();
		if (!driver.success) return driver;
		const state = fromDriver(await driver.data.biometrics(op));
		if (!state.success) return state;
		const { enrolled, modality } = state.data;
		return reply(
			device,
			await finishAction(opSessionFor(ctx, deps, device, env), driver.data, settle.data, {
				action: "biometrics",
				text:
					op === "status"
						? `${modality} ${enrolled ? "enrolled" : "not enrolled"}`
						: `${op}: ${modality} ${enrolled ? "enrolled" : "not enrolled"}`,
				...(op === "status" ? {} : { args: { op } }),
				extra: { biometrics: state.data },
			})
		);
	});
}
/** `warden ui screen screenshot [path]`: a PNG of the screen; default `$WARDEN_HOME/ui/<udid>/shots/NNN.png`. */
export function uiScreenshot(
	ctx: CommandContext,
	deps: UiDeps,
	pathArg: string | undefined,
	opts: ActionOptionValues
): Promise<number> {
	return runUi(ctx, deps, "screen screenshot", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		return reply(
			device,
			await screenshot(opSessionFor(ctx, deps, device, env), {
				...(pathArg !== undefined ? { path: pathArg } : {}),
				...(settle.data !== undefined ? { settleMs: settle.data } : {}),
			})
		);
	});
}
