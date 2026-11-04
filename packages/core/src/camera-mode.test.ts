import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cameraModePath,
	cameraSources,
	clearCameraMode,
	readCameraMode,
	sameCameraMode,
	usesVideo,
	writeCameraMode,
} from "./camera-mode";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "cam-mode-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("camera mode", () => {
	test("a missing or corrupt file is all-image", () => {
		const dir = tmp();
		expect(readCameraMode(dir)).toEqual({});
		writeFileSync(cameraModePath(dir), "{nope");
		expect(readCameraMode(dir)).toEqual({});
	});

	test("round-trips video file names per facing; unknown keys and non-strings are dropped", () => {
		const dir = tmp();
		writeCameraMode(dir, { back: "back.mp4" });
		expect(readCameraMode(dir)).toEqual({ back: "back.mp4" });
		writeFileSync(cameraModePath(dir), JSON.stringify({ back: "back.mov", front: 3, other: "x" }));
		expect(readCameraMode(dir)).toEqual({ back: "back.mov" });
	});

	test("writing an all-image mode removes the file; clear is idempotent", () => {
		const dir = tmp();
		writeCameraMode(dir, { front: "front.mp4" });
		writeCameraMode(dir, {});
		expect(existsSync(cameraModePath(dir))).toBe(false);
		clearCameraMode(dir);
		clearCameraMode(join(dir, "missing"));
	});

	test("sources: image facings read <facing>.png, video facings their file", () => {
		expect(cameraSources("/c", { back: "back.mp4" })).toEqual({
			back: "videofile:/c/back.mp4",
			front: "imagefile:/c/front.png",
		});
		expect(usesVideo({})).toBe(false);
		expect(usesVideo({ front: "front.mov" })).toBe(true);
	});

	test("sameCameraMode compares facing by facing", () => {
		expect(sameCameraMode({}, {})).toBe(true);
		expect(sameCameraMode({ back: "back.mp4" }, { back: "back.mp4" })).toBe(true);
		expect(sameCameraMode({ back: "back.mp4" }, { back: "back.mov" })).toBe(false);
		expect(sameCameraMode({ back: "back.mp4" }, {})).toBe(false);
	});
});
