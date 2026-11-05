import { copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
	type CameraMode,
	readCameraMode,
	sameCameraMode,
	usesVideo,
	writeCameraMode,
} from "@delacour/warden-core/camera-mode";
import { PLACEHOLDER_PNG } from "@delacour/warden-core/camera-placeholder";
import { splitCameraProfile } from "@delacour/warden-core/camera-profile";
import { cameraFeedDir, sniffCameraMedia } from "@delacour/warden-core/conditions/camera-media";
import { CAMERA_FACINGS, type CameraCondition } from "@delacour/warden-core/conditions/conditions.types";
import type { Exec } from "@delacour/warden-core/exec";
import type { CameraState, Driver, DriverResult } from "../driver.types";
import { driverErr } from "../errors";

export type AndroidCameraDeps = {
	serial: string;
	wardenHome: string;
	/** host process runner: `sips` re-encodes images to PNG */
	exec: Exec;
	/** the profile warden recorded for this device (`pixel-10+cam`); undefined = not a warden device */
	profile: () => string | undefined;
	/** restart the emulator on its own serial through the provider and wait until it is ready */
	relaunch: () => Promise<{ success: true; data: undefined } | { success: false; error: string }>;
	/** told the feeds now playing, so the lease carries the `camera` area and release undoes it */
	record?: (feeds: CameraCondition) => void;
};

/** One file to put in the feed dir: written next to its final name, then renamed over it. */
type Staged = { tmp: string; final: string };

type CameraFacing = (typeof CAMERA_FACINGS)[number];
type CameraFeed = NonNullable<CameraCondition[CameraFacing]>;
type CameraFailure = ReturnType<typeof driverErr>;

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The Android emulator camera. `-camera-back` / `-camera-front` name a file the emulator re-reads whenever an app
 * opens the camera, so an image swap is an atomic file replace (`appliesOnCameraOpen`). Only PNG renders, so every
 * other image is re-encoded with `sips`. The source TYPE (image or video) is fixed at launch: a change of it is
 * recorded in `mode.json` and the emulator is restarted on the same serial (`rebooted`).
 */
export function createAndroidCamera(deps: AndroidCameraDeps): Driver["camera"] {
	const dir = cameraFeedDir(deps.wardenHome, deps.serial);

	async function reencode(source: string, tmp: string): Promise<DriverResult<void>> {
		const done = await deps.exec(["sips", "-s", "format", "png", source, "--out", tmp]);
		if (done.exitCode === 0) return { success: true, data: undefined };
		return driverErr(
			"E_IO",
			`sips could not convert ${source} to PNG: ${`${done.stderr}${done.stdout}`.trim().slice(0, 200)}`
		);
	}

	/** Everything the next state needs, written to temp files; nothing is visible to the emulator yet. */
	async function prepare(feeds: CameraCondition): Promise<DriverResult<{ staged: Staged[]; mode: CameraMode }>> {
		const staged: Staged[] = [];
		const mode: CameraMode = {};
		for (const facing of CAMERA_FACINGS) {
			const failed = await prepareFacing(facing, feeds[facing], staged, mode);
			if (failed) return failed;
		}
		return { success: true, data: { staged, mode } };
	}

	/** Stages one facing's files: a placeholder PNG under a video or no feed, the feed itself otherwise. */
	async function prepareFacing(
		facing: CameraFacing,
		feed: CameraFeed | undefined,
		staged: Staged[],
		mode: CameraMode
	): Promise<CameraFailure | undefined> {
		const png = join(dir, `${facing}.png`);
		const tmpPng = join(dir, `.${facing}.png.tmp-${process.pid}`);
		if (feed === undefined || feed.kind === "video") {
			staged.push({ tmp: tmpPng, final: png });
			writeFileSync(tmpPng, PLACEHOLDER_PNG);
		}
		if (feed === undefined) return undefined;
		const sniffed = sniffCameraMedia(feed.path);
		if (!sniffed.success) return driverErr("E_BAD_REQUEST", sniffed.error.message);
		if (sniffed.data.kind !== feed.kind) {
			return driverErr("E_BAD_REQUEST", `${feed.path} is ${sniffed.data.kind} media, not a ${feed.kind} feed`);
		}
		if (feed.kind === "video") return stageVideo(facing, feed.path, staged, mode);
		staged.push({ tmp: tmpPng, final: png });
		if (sniffed.data.ext === "png") {
			copyFileSync(feed.path, tmpPng);
			return undefined;
		}
		const converted = await reencode(feed.path, tmpPng);
		return converted.success ? undefined : converted;
	}

	/** Copies a video feed next to its final name and records the file in the mode. */
	function stageVideo(facing: CameraFacing, path: string, staged: Staged[], mode: CameraMode): undefined {
		const name = `${facing}${extname(path).toLowerCase() || ".mp4"}`;
		const tmp = join(dir, `.${name}.tmp-${process.pid}`);
		copyFileSync(path, tmp);
		staged.push({ tmp, final: join(dir, name) });
		mode[facing] = name;
		return undefined;
	}

	function discard(staged: readonly Staged[]): void {
		for (const { tmp } of staged) rmSync(tmp, { force: true });
	}

	/** Makes the staged files visible to the emulator and drops the old feed files the new mode no longer names. */
	function commit(before: CameraMode, staged: readonly Staged[], mode: CameraMode): CameraFailure | undefined {
		try {
			for (const { tmp, final } of staged) renameSync(tmp, final);
			for (const facing of CAMERA_FACINGS) {
				const old = before[facing];
				if (old !== undefined && old !== mode[facing]) rmSync(join(dir, old), { force: true });
			}
			writeCameraMode(dir, mode);
			return undefined;
		} catch (error) {
			discard(staged);
			return driverErr("E_IO", `camera feed: ${message(error)}`);
		}
	}

	/** `prepare` with its throws (filesystem) turned into `E_IO`. */
	async function prepareGuarded(feeds: CameraCondition): Promise<Awaited<ReturnType<typeof prepare>>> {
		try {
			mkdirSync(dir, { recursive: true });
			return await prepare(feeds);
		} catch (error) {
			return driverErr("E_IO", `camera feed: ${message(error)}`);
		}
	}

	/** Restarts the emulator for a change of source type; a failure is `E_NOT_BOOTED`. */
	async function relaunchForMode(before: CameraMode, mode: CameraMode): Promise<CameraFailure | undefined> {
		const restarted = await deps.relaunch();
		if (restarted.success) return undefined;
		return driverErr(
			"E_NOT_BOOTED",
			`restarting ${deps.serial} to switch its camera between ${usesVideo(before) ? "video" : "image"} and ${usesVideo(mode) ? "video" : "image"} failed: ${restarted.error}`
		);
	}

	return async (op) => {
		const profile = deps.profile();
		if (profile === undefined || !splitCameraProfile(profile).camera) {
			return driverErr(
				"E_CAMERA_DEVICE",
				`${deps.serial} is not a camera emulator: its camera source is fixed when it launches, so claim it with --camera (profile \`camera: true\`)`
			);
		}
		// `null` arrives as `undefined` through `warden __android-host` (the wire drops null arguments): same meaning
		const feeds: CameraCondition = op ?? {};
		const before = readCameraMode(dir);
		const prepared = await prepareGuarded(feeds);
		if (!prepared.success) {
			rmTemps(dir);
			return prepared;
		}
		const { staged, mode } = prepared.data;
		const committed = commit(before, staged, mode);
		if (committed) return committed;
		deps.record?.(feeds);
		const state: CameraState = { feeds };
		if (sameCameraMode(before, mode))
			return { success: true, data: { ...state, appliesOnCameraOpen: true, rebooted: false } };
		const restarted = await relaunchForMode(before, mode);
		return restarted ?? { success: true, data: { ...state, rebooted: true } };
	};
}

function rmTemps(dir: string): void {
	for (const facing of CAMERA_FACINGS) {
		rmSync(join(dir, `.${facing}.png.tmp-${process.pid}`), { force: true });
		for (const ext of [".mp4", ".mov", ".m4v"])
			rmSync(join(dir, `.${facing}${ext}.tmp-${process.pid}`), { force: true });
	}
}
