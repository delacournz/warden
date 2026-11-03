import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAMERA_FACINGS, type CameraFacing } from "./conditions/conditions.types";

/**
 * Which cameras of an Android `+cam` emulator play a video: facing → the video file's name in the camera dir
 * (`back.mp4`). A facing left out plays `<facing>.png`. The source kind is fixed when the emulator launches, so
 * this file records what the RUNNING emulator was launched with; the next launch reads it.
 */
export type CameraMode = Partial<Record<CameraFacing, string>>;

export function cameraModePath(dir: string): string {
	return join(dir, "mode.json");
}

/** The recorded mode; a missing or unreadable file is all-image. */
export function readCameraMode(dir: string): CameraMode {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(cameraModePath(dir), "utf8"));
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null) return {};
	const mode: CameraMode = {};
	for (const facing of CAMERA_FACINGS) {
		const name: unknown = Reflect.get(parsed, facing);
		if (typeof name === "string" && name.length > 0) mode[facing] = name;
	}
	return mode;
}

/** Record `mode` atomically; an all-image mode removes the file. */
export function writeCameraMode(dir: string, mode: CameraMode): void {
	if (!usesVideo(mode)) {
		clearCameraMode(dir);
		return;
	}
	mkdirSync(dir, { recursive: true });
	const tmp = `${cameraModePath(dir)}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(mode));
	renameSync(tmp, cameraModePath(dir));
}

export function clearCameraMode(dir: string): void {
	rmSync(cameraModePath(dir), { force: true });
}

export function usesVideo(mode: CameraMode): boolean {
	return CAMERA_FACINGS.some((f) => mode[f] !== undefined);
}

export function sameCameraMode(a: CameraMode, b: CameraMode): boolean {
	return CAMERA_FACINGS.every((f) => a[f] === b[f]);
}

/** The emulator's `-camera-back` / `-camera-front` values for `mode`. */
export function cameraSources(dir: string, mode: CameraMode): Record<CameraFacing, string> {
	const source = (facing: CameraFacing): string => {
		const video = mode[facing];
		return video !== undefined ? `videofile:${join(dir, video)}` : `imagefile:${join(dir, `${facing}.png`)}`;
	};
	return { back: source("back"), front: source("front") };
}
