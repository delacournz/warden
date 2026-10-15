import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDevice, type Device } from "@delacour/warden-e2e/device";
import type { Driver, Orientation } from "@delacour/warden-e2e/driver/driver.types";
import type { E2eEnv } from "@delacour/warden-e2e/env";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { type ActionOptionValues, finishAction, fromE2eError, parseSettle } from "./act";
import type { UiDevice } from "./device";
import { fromDriver, type UiDeps } from "./driver";
import { type UiError, uiError } from "./output";
import { runUi } from "./run";
import { readState, uiDir } from "./state";

/** `createDevice` over a `warden ui` driver: alerts, `openLink`, home/back, driven by the command's clock. */
export function deviceFacade(
	ctx: CommandContext,
	deps: UiDeps,
	device: UiDevice,
	driver: Driver,
	timeoutMs: number
): Device {
	const state = readState(ctx, device.udid);
	const out = join(uiDir(ctx, device.udid), "e2e");
	const env: E2eEnv = {
		udid: device.udid,
		platform: device.platform,
		bundleId: state.app ?? "",
		...(state.metroUrl !== undefined ? { metroUrl: state.metroUrl } : {}),
		launchArgs: [],
		out,
		timeoutMs,
		actionTimeoutMs: timeoutMs,
		assertionTimeoutMs: timeoutMs,
		headless: true,
		logTimestamps: false,
	};
	return createDevice({ session: { out }, driver, env, clock: { now: ctx.now, sleep: deps.sleep } });
}

/** Run `work`, turning an `E2eError` thrown by the `createDevice` facade into a `warden ui` error. */
export async function viaFacade<T>(work: () => Promise<T>): Promise<Result<T, UiError>> {
	try {
		return ok(await work());
	} catch (error) {
		const mapped = fromE2eError(error);
		if (mapped) return { success: false, error: mapped };
		throw error;
	}
}

const ORIENTATIONS: Record<string, Orientation> = {
	portrait: "portrait",
	portraitupsidedown: "portraitUpsideDown",
	landscapeleft: "landscapeLeft",
	landscaperight: "landscapeRight",
};

/** `landscape-left`, `landscapeLeft`, `LANDSCAPE_LEFT` → `landscapeLeft`. */
export function parseOrientation(raw: string): Result<Orientation, UiError> {
	const found = ORIENTATIONS[raw.toLowerCase().replace(/[-_\s]/g, "")];
	if (found) return ok(found);
	return {
		success: false,
		error: uiError("usage", `unknown orientation "${raw}"`, {
			hint: "portrait, portrait-upside-down, landscape-left or landscape-right",
		}),
	};
}

function nameOf(button: { label?: string; text?: string; value?: string }): string {
	return button.label ?? button.text ?? button.value ?? "?";
}

/** `warden ui alert accept|dismiss|get`: answer the system alert / sheet on top, or read it. */
export function uiAlert(ctx: CommandContext, deps: UiDeps, what: string, opts: ActionOptionValues): Promise<number> {
	return runUi(ctx, deps, "alert", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		if (what !== "accept" && what !== "dismiss" && what !== "get") {
			return {
				success: false,
				error: uiError("usage", `unknown alert action "${what}"`, { hint: "accept, dismiss or get" }),
			};
		}
		const driver = await env.driver();
		if (!driver.success) return driver;
		if (what === "get") {
			const info = fromDriver(await driver.data.alert());
			if (!info.success) return info;
			const buttons = (info.data?.buttons ?? []).map(nameOf);
			const alert = info.data ? { title: info.data.title ?? null, message: info.data.message ?? null, buttons } : null;
			return ok({
				device: { udid: device.udid, platform: device.platform, name: device.name },
				result: { action: "alert", alert },
				text:
					alert === null
						? "no alert showing"
						: [
								`alert${alert.title ? ` ${JSON.stringify(alert.title)}` : ""}${alert.message ? ` — ${alert.message}` : ""}`,
								...buttons.map((name) => `  [${name}]`),
							].join("\n"),
			});
		}
		const facade = deviceFacade(ctx, deps, device, driver.data, env.timeoutMs);
		const handled = await viaFacade(() => facade.alert(what));
		if (!handled.success) return handled;
		if (!handled.data) {
			return {
				success: false,
				error: uiError("target_not_found", "no alert is showing", { hint: "`warden ui alert get` reads it" }),
			};
		}
		return finishAction(ctx, deps, env, device, driver.data, settle.data, {
			action: "alert",
			text: what === "accept" ? "accepted the alert" : "dismissed the alert",
			args: { choice: what },
			extra: { choice: what },
		});
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
		const driver = await env.driver();
		if (!driver.success) return driver;
		const facade = deviceFacade(ctx, deps, device, driver.data, env.timeoutMs);
		const pressed = await viaFacade(() => (button === "home" ? facade.home() : facade.back()));
		if (!pressed.success) return pressed;
		return finishAction(ctx, deps, env, device, driver.data, settle.data, {
			action: button,
			text: `pressed ${button}`,
		});
	});
}

/** `warden ui rotate [orientation]`: set the orientation, or read it. */
export function uiRotate(
	ctx: CommandContext,
	deps: UiDeps,
	raw: string | undefined,
	opts: ActionOptionValues
): Promise<number> {
	return runUi(ctx, deps, "rotate", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		const wanted = raw === undefined ? undefined : parseOrientation(raw);
		if (wanted && !wanted.success) return wanted;
		const driver = await env.driver();
		if (!driver.success) return driver;
		const now = fromDriver(await driver.data.orientation(wanted?.data));
		if (!now.success) return now;
		return finishAction(ctx, deps, env, device, driver.data, settle.data, {
			action: "rotate",
			text: wanted ? `orientation ${now.data}` : `orientation is ${now.data}`,
			...(wanted ? { args: { orientation: now.data } } : {}),
			extra: { orientation: now.data },
		});
	});
}

/** `warden ui appearance [light|dark]`: set the appearance, or read it. */
export function uiAppearance(
	ctx: CommandContext,
	deps: UiDeps,
	raw: string | undefined,
	opts: ActionOptionValues
): Promise<number> {
	return runUi(ctx, deps, "appearance", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		if (raw !== undefined && raw !== "light" && raw !== "dark") {
			return {
				success: false,
				error: uiError("usage", `unknown appearance "${raw}"`, { hint: "light or dark" }),
			};
		}
		const driver = await env.driver();
		if (!driver.success) return driver;
		const now = fromDriver(await driver.data.appearance(raw));
		if (!now.success) return now;
		return finishAction(ctx, deps, env, device, driver.data, settle.data, {
			action: "appearance",
			text: raw === undefined ? `appearance is ${now.data}` : `appearance ${now.data}`,
			...(raw === undefined ? {} : { args: { mode: now.data } }),
			extra: { appearance: now.data },
		});
	});
}

/** The next free `NNN.png` in `<uiDir>/shots`. */
export function nextShotPath(ctx: CommandContext, udid: string): string {
	const dir = join(uiDir(ctx, udid), "shots");
	mkdirSync(dir, { recursive: true });
	let highest = 0;
	for (const file of readdirSync(dir)) {
		const n = /^(\d{3,})\.png$/.exec(file)?.[1];
		if (n !== undefined) highest = Math.max(highest, Number(n));
	}
	return join(dir, `${String(highest + 1).padStart(3, "0")}.png`);
}

/** `warden ui screenshot [path]`: a PNG of the screen; default `$WARDEN_HOME/ui/<udid>/shots/NNN.png`. */
export function uiScreenshot(
	ctx: CommandContext,
	deps: UiDeps,
	pathArg: string | undefined,
	opts: ActionOptionValues
): Promise<number> {
	return runUi(ctx, deps, "screenshot", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		const path = pathArg === undefined ? nextShotPath(ctx, device.udid) : resolve(ctx.cwd, pathArg);
		const driver = await env.driver();
		if (!driver.success) return driver;
		mkdirSync(join(path, ".."), { recursive: true });
		const shot = fromDriver(await driver.data.screenshot({ path }));
		if (!shot.success) return shot;
		if (shot.data.png !== undefined && shot.data.png.length > 0 && !existsSync(path)) {
			writeFileSync(path, shot.data.png);
		}
		const written = shot.data.path ?? path;
		return finishAction(ctx, deps, env, device, driver.data, settle.data, {
			action: "screenshot",
			text: written,
			extra: { path: written },
		});
	});
}
