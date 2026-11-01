import type { BiometricOp } from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import { actionFlow } from "@delacour/warden-sdk/ops/act";
import { controlOps } from "@delacour/warden-sdk/ops/controls";
import type { Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { type ActionOptionValues, uiArgs } from "./args";
import { type UiDevice, uiDeviceResolver } from "./device";
import { opErrors, type UiDeps } from "./driver";
import { type UiError, uiOutput } from "./output";
import { uiRun } from "./run";
import { uiSession } from "./session";

const BIOMETRIC_OPS: readonly BiometricOp[] = ["status", "enroll", "unenroll", "match", "fail"];

export class UiControls {
	/** `warden ui alert accept|dismiss|get`: answer the system alert / sheet on top, or read it. */
	uiAlert(ctx: CommandContext, deps: UiDeps, what: string, opts: ActionOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "alert", opts, async (device, env) => {
			const settle = uiArgs.parseSettle(opts.settle);
			if (!settle.success) return settle;
			return uiSession.reply(
				device,
				await controlOps.alert(uiSession.opSessionFor(ctx, deps, device, env), {
					action: what,
					...(settle.data !== undefined ? { settleMs: settle.data } : {}),
				})
			);
		});
	}

	/** `warden ui home` / `warden ui back` (Android only). */
	uiHardware(ctx: CommandContext, deps: UiDeps, button: "home" | "back", opts: ActionOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, button, opts, async (device, env) => {
			const settle = uiArgs.parseSettle(opts.settle);
			if (!settle.success) return settle;
			return uiSession.reply(
				device,
				await controlOps.hardware(uiSession.opSessionFor(ctx, deps, device, env), {
					button,
					...(settle.data !== undefined ? { settleMs: settle.data } : {}),
				})
			);
		});
	}

	/** `warden ui screen rotate [orientation]`: set the orientation, or read it. */
	uiRotate(ctx: CommandContext, deps: UiDeps, raw: string | undefined, opts: ActionOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "screen rotate", opts, async (device, env) => {
			const settle = uiArgs.parseSettle(opts.settle);
			if (!settle.success) return settle;
			return uiSession.reply(
				device,
				await controlOps.screenRotate(uiSession.opSessionFor(ctx, deps, device, env), {
					...(raw !== undefined ? { orientation: raw } : {}),
					...(settle.data !== undefined ? { settleMs: settle.data } : {}),
				})
			);
		});
	}

	/** `warden ui screen appearance [light|dark]`: set the appearance, or read it. */
	uiAppearance(ctx: CommandContext, deps: UiDeps, raw: string | undefined, opts: ActionOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "screen appearance", opts, async (device, env) => {
			const settle = uiArgs.parseSettle(opts.settle);
			if (!settle.success) return settle;
			return uiSession.reply(
				device,
				await controlOps.screenAppearance(uiSession.opSessionFor(ctx, deps, device, env), {
					...(raw !== undefined ? { mode: raw } : {}),
					...(settle.data !== undefined ? { settleMs: settle.data } : {}),
				})
			);
		});
	}

	/** `warden ui biometrics [status|enroll|unenroll|match|fail]`: simulated Face ID / Touch ID / fingerprint; no op reads the state. */
	uiBiometrics(ctx: CommandContext, deps: UiDeps, raw: string | undefined, opts: ActionOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "biometrics", opts, async (device, env) => {
			const settle = uiArgs.parseSettle(opts.settle);
			if (!settle.success) return settle;
			const op = this.biometricOp(raw);
			if (!op.success) return op;
			const unsupported = this.biometricsUnsupported(device);
			if (unsupported !== undefined) return unsupported;
			const driver = await env.driver();
			if (!driver.success) return driver;
			const state = opErrors.fromDriver(await driver.data.biometrics(op.data));
			if (!state.success) return state;
			const { enrolled, modality } = state.data;
			return uiSession.reply(
				device,
				await actionFlow.finishAction(uiSession.opSessionFor(ctx, deps, device, env), driver.data, settle.data, {
					action: "biometrics",
					text: this.biometricsText(op.data, modality, enrolled),
					...(op.data === "status" ? {} : { args: { op: op.data } }),
					extra: { biometrics: state.data },
				})
			);
		});
	}

	private biometricOp(raw: string | undefined): Result<BiometricOp, UiError> {
		const op = BIOMETRIC_OPS.find((candidate) => candidate === (raw ?? "status"));
		if (op !== undefined) return { success: true, data: op };
		return {
			success: false,
			error: uiOutput.uiError("usage", `unknown biometrics op "${raw}"`, { hint: BIOMETRIC_OPS.join(" | ") }),
		};
	}

	private biometricsUnsupported(device: UiDevice): Result<never, UiError> | undefined {
		if (!uiDeviceResolver.physicalDevice(device)) return undefined;
		const what = device.platform === "ios" ? "a physical iPhone" : "a physical Android device";
		return opErrors.fromDriver(
			driverErrors.err(
				"E_UNSUPPORTED",
				`biometrics is not available on ${what}: a real Face ID / fingerprint sensor is never enrolled or matched; use a simulator or emulator`
			)
		);
	}

	private biometricsText(op: string, modality: string, enrolled: boolean): string {
		const state = `${modality} ${enrolled ? "enrolled" : "not enrolled"}`;
		return op === "status" ? state : `${op}: ${state}`;
	}

	/** `warden ui screen screenshot [path]`: a PNG of the screen; default `$WARDEN_HOME/ui/<udid>/shots/NNN.png`. */
	uiScreenshot(
		ctx: CommandContext,
		deps: UiDeps,
		pathArg: string | undefined,
		opts: ActionOptionValues
	): Promise<number> {
		return uiRun.runUi(ctx, deps, "screen screenshot", opts, async (device, env) => {
			const settle = uiArgs.parseSettle(opts.settle);
			if (!settle.success) return settle;
			return uiSession.reply(
				device,
				await controlOps.screenshot(uiSession.opSessionFor(ctx, deps, device, env), {
					...(pathArg !== undefined ? { path: pathArg } : {}),
					...(settle.data !== undefined ? { settleMs: settle.data } : {}),
				})
			);
		});
	}
}

export const uiControls = new UiControls();
