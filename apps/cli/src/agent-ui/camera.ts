import { basename, resolve } from "node:path";
import { stageCameraFeed } from "@delacour/warden-core/conditions/camera-media";
import type { CameraCondition, CameraFacing } from "@delacour/warden-core/conditions/conditions.types";
import { wardenHome } from "@delacour/warden-core/store";
import type { CameraState } from "@delacour/warden-e2e/driver/driver.types";
import type { Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { fail, recordOf, resolveDeps, withPort } from "./conditions";
import type { UiDevice } from "./device";
import { fromDriver, type UiDeps } from "./driver";
import type { UiError, UiSuccess } from "./output";
import { runUi, type UiOptionValues } from "./run";
import { forget, save, success } from "./settings";

export type CameraOptionValues = UiOptionValues & { facing?: string; loop?: boolean };

/** A video feed can reboot the emulator: well past the 5 s every other `ui` verb gets. */
const CAMERA_SET_TIMEOUT_MS = "120000";

type FacingChoice = CameraFacing | "both";

function parseFacing(raw: string | undefined, fallback: FacingChoice): Result<readonly CameraFacing[], UiError> {
	const choice = raw ?? fallback;
	if (choice === "back" || choice === "front") return { success: true, data: [choice] };
	if (choice === "both") return { success: true, data: ["back", "front"] };
	return fail("usage", `unknown --facing "${choice}"`, "back, front or both");
}

/** `back image a1b2c3.png · front video (loop) clip.mp4`; `none` for an empty camera. */
export function describeCamera(feeds: CameraCondition): string {
	const parts = (["back", "front"] as const).flatMap((facing) => {
		const feed = feeds[facing];
		if (feed === undefined) return [];
		const kind = feed.kind === "video" ? `video${feed.loop ? " (loop)" : ""}` : "image";
		return [`${facing} ${kind} ${basename(feed.path)}`];
	});
	return parts.length === 0 ? "none" : parts.join(" · ");
}

/** When the new feeds show, from what the driver reported: live (iOS), next launch, next camera open or after a reboot. */
export function cameraTiming(
	state: Pick<CameraState, "appliesOnLaunch" | "appliesOnCameraOpen" | "rebooted">
): string[] {
	const notes: string[] = [];
	if (state.rebooted === true) notes.push("the emulator rebooted to switch its camera source");
	if (state.appliesOnLaunch === true)
		notes.push("applies when the app next launches (`warden ui open` it): it was started without the camera");
	if (state.appliesOnCameraOpen === true)
		notes.push("an open camera keeps its old frames: the app shows the new feed the next time it opens the camera");
	return notes;
}

function applied(device: UiDevice, action: string, state: CameraState): Result<UiSuccess, UiError> {
	const notes = cameraTiming(state);
	return success(device, action, [`camera  ${describeCamera(state.feeds)}`, ...notes.map((n) => `  ${n}`)].join("\n"), {
		camera: state.feeds,
		...(state.appliesOnLaunch === undefined ? {} : { appliesOnLaunch: state.appliesOnLaunch }),
		...(state.appliesOnCameraOpen === undefined ? {} : { appliesOnCameraOpen: state.appliesOnCameraOpen }),
		...(state.rebooted === undefined ? {} : { rebooted: state.rebooted }),
	});
}

async function cameraSet(
	ctx: CommandContext,
	deps: Awaited<ReturnType<typeof resolveDeps>>,
	device: UiDevice,
	path: string | undefined,
	opts: CameraOptionValues
): Promise<Result<UiSuccess, UiError>> {
	if (path === undefined || path === "") return fail("usage", "camera set needs the path of an image or video");
	const facings = parseFacing(opts.facing, "back");
	if (!facings.success) return facings;
	const source = resolve(ctx.cwd, path);
	const next: CameraCondition = { ...(recordOf(ctx, device.lease.id, "camera")?.value ?? {}) };
	for (const facing of facings.data) {
		const staged = stageCameraFeed({
			wardenHome: wardenHome(ctx.env),
			udid: device.udid,
			facing,
			source,
			loop: opts.loop !== false,
		});
		if (!staged.success) return fail("failed", `${staged.error.code}: ${staged.error.message}`);
		next[facing] = staged.data;
	}
	return withPort<UiSuccess>(ctx, deps, device, async (port) => {
		const done = fromDriver(await port.camera(next));
		if (!done.success) return done;
		const saved = save(ctx, device, "camera", done.data.feeds);
		if (!saved.success) return saved;
		return applied(device, "camera-set", done.data);
	});
}

async function cameraClear(
	ctx: CommandContext,
	deps: Awaited<ReturnType<typeof resolveDeps>>,
	device: UiDevice,
	opts: CameraOptionValues
): Promise<Result<UiSuccess, UiError>> {
	const facings = parseFacing(opts.facing, "both");
	if (!facings.success) return facings;
	const current = recordOf(ctx, device.lease.id, "camera")?.value;
	if (current === undefined || Object.keys(current).length === 0) {
		return success(device, "camera-clear", "camera was not set", { changed: false, camera: {} });
	}
	const next: CameraCondition = { ...current };
	for (const facing of facings.data) delete next[facing];
	return withPort<UiSuccess>(ctx, deps, device, async (port) => {
		const done = fromDriver(await port.camera(Object.keys(next).length === 0 ? null : next));
		if (!done.success) return done;
		if (Object.keys(done.data.feeds).length === 0) forget(ctx, device, "camera");
		else {
			const saved = save(ctx, device, "camera", done.data.feeds);
			if (!saved.success) return saved;
		}
		return applied(device, "camera-clear", done.data);
	});
}

/**
 * `warden ui camera set <path> [--facing back|front|both] [--no-loop]` feeds an image or video into the app's camera,
 * `status` reads what the lease has, `clear [--facing …]` takes it off. The state lives in the lease's condition store,
 * so `device.camera` in a spec and this verb agree, and `warden release` undoes it.
 */
export function uiCamera(
	ctx: CommandContext,
	deps: UiDeps,
	action: string,
	path: string | undefined,
	opts: CameraOptionValues
): Promise<number> {
	const timed = action === "set" && opts.timeout === undefined ? { ...opts, timeout: CAMERA_SET_TIMEOUT_MS } : opts;
	return runUi(ctx, deps, `camera ${action}`, timed, async (device) => {
		switch (action) {
			case "set":
				return cameraSet(ctx, await resolveDeps(deps), device, path, opts);
			case "clear":
				return cameraClear(ctx, await resolveDeps(deps), device, opts);
			case "status": {
				const feeds = recordOf(ctx, device.lease.id, "camera")?.value;
				return success(device, "camera-status", `camera  ${feeds === undefined ? "not set" : describeCamera(feeds)}`, {
					camera: feeds ?? null,
				});
			}
			default:
				return fail("usage", `unknown camera action "${action}"`, "set, clear or status");
		}
	});
}
