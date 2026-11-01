import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Device, DeviceImpl } from "@delacour/warden-device/device";
import type { BiometricOp, BiometricState, Driver, Orientation } from "@delacour/warden-driver/driver.types";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { type ActionResult, actionFlow } from "./act";
import { opErrors } from "./errors";
import { uiPaths } from "./paths";
import type { OpOutcome, OpSession } from "./session";

const ORIENTATIONS: Record<string, Orientation> = {
	portrait: "portrait",
	portraitupsidedown: "portraitUpsideDown",
	landscapeleft: "landscapeLeft",
	landscaperight: "landscapeRight",
};

// ---- alert -------------------------------------------------------------------------------------------------------

export type AlertParams = {
	/** `accept` | `dismiss` | `get` (read it without answering) */
	action: string;
	settleMs?: number;
};
export type AlertReadResult = {
	action: "alert";
	present: boolean;
	alert: { title: string | null; message: string | null; buttons: string[] } | null;
	buttons: string[];
};
export type AlertAnswerResult = ActionResult & { choice: "accept" | "dismiss" };
export type AlertResult = AlertReadResult | AlertAnswerResult;

type AlertAction = "accept" | "dismiss" | "get";

// ---- home / back -------------------------------------------------------------------------------------------------

export type HardwareParams = { button: "home" | "back"; settleMs?: number };
export type HardwareResult = ActionResult;

// ---- screen rotate / appearance ----------------------------------------------------------------------------------

export type ScreenRotateParams = {
	/** `portrait` | `portrait-upside-down` | `landscape-left` | `landscape-right`; absent = read it */
	orientation?: string;
	settleMs?: number;
};
export type ScreenRotateResult = ActionResult & { orientation: Orientation };

export type ScreenAppearanceParams = {
	/** `light` | `dark`; absent = read it */
	mode?: string;
	settleMs?: number;
};
export type ScreenAppearanceResult = ActionResult & { appearance: "light" | "dark" };

// ---- biometrics --------------------------------------------------------------------------------------------------

export const BIOMETRIC_OPS: readonly BiometricOp[] = ["status", "enroll", "unenroll", "match", "fail"];

export type BiometricsParams = {
	/** `status` (default) | `enroll` | `unenroll` | `match` | `fail` */
	op?: string;
	/** the device is a phone: a real Face ID / fingerprint sensor is never enrolled or matched */
	physical?: boolean;
	settleMs?: number;
};
export type BiometricsResult = ActionResult & { biometrics: BiometricState };

export type ScreenshotParams = {
	/** output file, relative to the session's cwd; default `<home>/ui/<id>/shots/NNN.png` */
	path?: string;
	settleMs?: number;
};
export type ScreenshotResult = ActionResult & { path: string };

export class ControlOps {
	/** `DeviceImpl` over an op session's driver: alerts, `openLink`, home/back, driven by the session's clock. */
	deviceFacade(session: OpSession, driver: Driver): Device {
		const { app } = session.state.read();
		const out = join(uiPaths.uiDir(session.host.home, session.device.id), "e2e");
		return new DeviceImpl({
			driver,
			artifactsDir: join(out, "adhoc"),
			...(app === undefined ? {} : { appId: app }),
			clock: { now: session.host.now, sleep: session.host.sleep },
		});
	}

	/** Run `work`, turning an `E2eError` thrown by the `DeviceImpl` facade into an op error. */
	async viaFacade<T>(work: () => Promise<T>): Promise<Result<T, WardenError>> {
		try {
			return resultFactory.ok(await work());
		} catch (error) {
			const mapped = actionFlow.fromE2eError(error);
			if (mapped) return opErrors.fail(mapped);
			throw error;
		}
	}

	/** `landscape-left`, `landscapeLeft`, `LANDSCAPE_LEFT` → `landscapeLeft`. */
	parseOrientation(raw: string): Result<Orientation, WardenError> {
		const found = ORIENTATIONS[raw.toLowerCase().replace(/[-_\s]/g, "")];
		if (found) return resultFactory.ok(found);
		return opErrors.fail(
			opErrors.opError("usage", `unknown orientation "${raw}"`, {
				hint: "portrait, portrait-upside-down, landscape-left or landscape-right",
			})
		);
	}

	private nameOf(button: { label?: string; text?: string; value?: string }): string {
		return button.label ?? button.text ?? button.value ?? "?";
	}

	/** Whether `what` is one of the alert subcommands. */
	private isAlertAction(what: string): what is AlertAction {
		return what === "accept" || what === "dismiss" || what === "get";
	}

	/** The human text of `alert get`: the title and message, then one line per button. */
	private alertText(alert: { title: string | null; message: string | null } | null, buttons: string[]): string {
		if (alert === null) return "no alert showing";
		return [
			`alert${alert.title ? ` ${JSON.stringify(alert.title)}` : ""}${alert.message ? ` — ${alert.message}` : ""}`,
			...buttons.map((name) => `  [${name}]`),
		].join("\n");
	}

	/** `alert get`: read the alert on top without touching it. */
	private async readAlert(driver: Driver): OpOutcome<AlertReadResult> {
		const info = opErrors.fromDriver(await driver.alert());
		if (!info.success) return info;
		const buttons = (info.data?.buttons ?? []).map((button) => this.nameOf(button));
		const found = info.data ? { title: info.data.title ?? null, message: info.data.message ?? null, buttons } : null;
		return resultFactory.ok({
			result: { action: "alert", present: found !== null, alert: found, buttons },
			text: this.alertText(found, buttons),
		});
	}

	/** `alert accept|dismiss`: answer the alert on top; `no_alert` when none is showing. */
	private async answerAlert(
		session: OpSession,
		driver: Driver,
		what: "accept" | "dismiss",
		settleMs: number | undefined
	): OpOutcome<AlertAnswerResult> {
		const facade = this.deviceFacade(session, driver);
		const handled = await this.viaFacade(() => facade.alert(what));
		if (!handled.success) return handled;
		if (!handled.data) {
			return opErrors.fail(
				opErrors.opError("no_alert", `no alert is showing to ${what}`, {
					hint: "`warden ui alert get` reads it (an empty buttons list means none)",
				})
			);
		}
		return actionFlow.finishAction(session, driver, settleMs, {
			action: "alert",
			text: what === "accept" ? "accepted the alert" : "dismissed the alert",
			args: { choice: what },
			extra: { choice: what },
		});
	}

	/** `warden ui alert accept|dismiss|get`: answer the system alert / sheet on top, or read it. */
	async alert(session: OpSession, params: AlertParams): OpOutcome<AlertResult> {
		const what = params.action;
		if (!this.isAlertAction(what)) {
			return opErrors.fail(
				opErrors.opError("usage", `unknown alert action "${what}"`, { hint: "accept, dismiss or get" })
			);
		}
		const driver = await session.driver();
		if (!driver.success) return driver;
		if (what === "get") return this.readAlert(driver.data);
		return this.answerAlert(session, driver.data, what, params.settleMs);
	}

	/** `warden ui home` / `warden ui back` (Android only). */
	async hardware(session: OpSession, params: HardwareParams): OpOutcome<HardwareResult> {
		const driver = await session.driver();
		if (!driver.success) return driver;
		const facade = this.deviceFacade(session, driver.data);
		const pressed = await this.viaFacade(() => (params.button === "home" ? facade.home() : facade.back()));
		if (!pressed.success) return pressed;
		return actionFlow.finishAction(session, driver.data, params.settleMs, {
			action: params.button,
			text: `pressed ${params.button}`,
		});
	}

	/** `warden ui screen rotate [orientation]`: set the orientation, or read it. */
	async screenRotate(session: OpSession, params: ScreenRotateParams): OpOutcome<ScreenRotateResult> {
		const wanted = params.orientation === undefined ? undefined : this.parseOrientation(params.orientation);
		if (wanted && !wanted.success) return wanted;
		const driver = await session.driver();
		if (!driver.success) return driver;
		const now = opErrors.fromDriver(await driver.data.orientation(wanted?.data));
		if (!now.success) return now;
		return actionFlow.finishAction(session, driver.data, params.settleMs, {
			action: "screen-rotate",
			text: wanted ? `orientation ${now.data}` : `orientation is ${now.data}`,
			...(wanted ? { args: { orientation: now.data } } : {}),
			extra: { orientation: now.data },
		});
	}

	/** `warden ui screen appearance [light|dark]`: set the appearance, or read it. */
	async screenAppearance(session: OpSession, params: ScreenAppearanceParams): OpOutcome<ScreenAppearanceResult> {
		const raw = params.mode;
		if (raw !== undefined && raw !== "light" && raw !== "dark") {
			return opErrors.fail(opErrors.opError("usage", `unknown appearance "${raw}"`, { hint: "light or dark" }));
		}
		const driver = await session.driver();
		if (!driver.success) return driver;
		const now = opErrors.fromDriver(await driver.data.appearance(raw));
		if (!now.success) return now;
		return actionFlow.finishAction(session, driver.data, params.settleMs, {
			action: "screen-appearance",
			text: raw === undefined ? `appearance is ${now.data}` : `appearance ${now.data}`,
			...(raw === undefined ? {} : { args: { mode: now.data } }),
			extra: { appearance: now.data },
		});
	}

	/** `warden ui biometrics [status|enroll|unenroll|match|fail]`: simulated Face ID / Touch ID / fingerprint; no op reads the state. */
	async biometrics(session: OpSession, params: BiometricsParams): OpOutcome<BiometricsResult> {
		const op = BIOMETRIC_OPS.find((candidate) => candidate === (params.op ?? "status"));
		if (op === undefined) {
			return opErrors.fail(
				opErrors.opError("usage", `unknown biometrics op "${params.op}"`, { hint: BIOMETRIC_OPS.join(" | ") })
			);
		}
		if (params.physical === true) {
			const what = session.device.platform === "ios" ? "a physical iPhone" : "a physical Android device";
			return opErrors.fail(
				opErrors.opError(
					"unsupported",
					`biometrics is not available on ${what}: a real Face ID / fingerprint sensor is never enrolled or matched; use a simulator or emulator`
				)
			);
		}
		const driver = await session.driver();
		if (!driver.success) return driver;
		const state = opErrors.fromDriver(await driver.data.biometrics(op));
		if (!state.success) return state;
		const { enrolled, modality } = state.data;
		return actionFlow.finishAction(session, driver.data, params.settleMs, {
			action: "biometrics",
			text:
				op === "status"
					? `${modality} ${enrolled ? "enrolled" : "not enrolled"}`
					: `${op}: ${modality} ${enrolled ? "enrolled" : "not enrolled"}`,
			...(op === "status" ? {} : { args: { op } }),
			extra: { biometrics: state.data },
		});
	}

	// ---- screenshot --------------------------------------------------------------------------------------------------

	/** The next free `NNN.png` in `<home>/ui/<id>/shots`. */
	nextShotPath(session: OpSession): string {
		const dir = join(uiPaths.uiDir(session.host.home, session.device.id), "shots");
		mkdirSync(dir, { recursive: true });
		let highest = 0;
		for (const file of readdirSync(dir)) {
			const n = /^(\d{3,})\.png$/.exec(file)?.[1];
			if (n !== undefined) highest = Math.max(highest, Number(n));
		}
		return join(dir, `${String(highest + 1).padStart(3, "0")}.png`);
	}

	/** `warden ui screen screenshot [path]`: a PNG of the screen. */
	async screenshot(session: OpSession, params: ScreenshotParams): OpOutcome<ScreenshotResult> {
		const path = params.path === undefined ? this.nextShotPath(session) : resolve(session.host.cwd, params.path);
		const driver = await session.driver();
		if (!driver.success) return driver;
		mkdirSync(join(path, ".."), { recursive: true });
		const shot = opErrors.fromDriver(await driver.data.screenshot({ path }));
		if (!shot.success) return shot;
		if (shot.data.png !== undefined && shot.data.png.length > 0 && !existsSync(path)) {
			writeFileSync(path, shot.data.png);
		}
		const written = shot.data.path ?? path;
		return actionFlow.finishAction(session, driver.data, params.settleMs, {
			action: "screen-screenshot",
			text: written,
			extra: { path: written },
		});
	}
}

export const controlOps = new ControlOps();
