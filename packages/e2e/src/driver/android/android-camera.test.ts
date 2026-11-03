import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLACEHOLDER_PNG } from "@delacour/warden-core/camera-placeholder";
import { cameraFeedDir } from "@delacour/warden-core/conditions/camera-media";
import type { CameraCondition } from "@delacour/warden-core/conditions/conditions.types";
import type { Exec } from "@delacour/warden-core/exec";
import { type AndroidCameraDeps, createAndroidCamera } from "./android-camera";

const SERIAL = "emulator-5554";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

let home: string;
let src: string;
let sips: string[][];
let relaunches: number;
let recorded: CameraCondition[];
let profile: string | undefined;
let relaunchResult: { success: true; data: undefined } | { success: false; error: string };

const feedDir = () => cameraFeedDir(home, SERIAL);

/** A fake `sips`: writes a PNG to the `--out` path. */
const exec: Exec = async (cmd) => {
	sips.push([...cmd]);
	const out = cmd[cmd.indexOf("--out") + 1];
	if (out !== undefined) writeFileSync(out, Buffer.concat([PNG_MAGIC, Buffer.from("from-sips")]));
	return { exitCode: 0, stdout: "", stderr: "" };
};

function camera(over: Partial<AndroidCameraDeps> = {}) {
	return createAndroidCamera({
		serial: SERIAL,
		wardenHome: home,
		exec,
		profile: () => profile,
		relaunch: async () => {
			relaunches++;
			return relaunchResult;
		},
		record: (feeds) => recorded.push(feeds),
		...over,
	});
}

function file(name: string, bytes: Buffer): string {
	const path = join(src, name);
	writeFileSync(path, bytes);
	return path;
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "warden-cam-home-"));
	src = mkdtempSync(join(tmpdir(), "warden-cam-src-"));
	mkdirSync(feedDir(), { recursive: true });
	writeFileSync(join(feedDir(), "back.png"), PLACEHOLDER_PNG);
	writeFileSync(join(feedDir(), "front.png"), PLACEHOLDER_PNG);
	sips = [];
	relaunches = 0;
	recorded = [];
	profile = "pixel-10+cam";
	relaunchResult = { success: true, data: undefined };
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(src, { recursive: true, force: true });
});

describe("android camera op", () => {
	test("a device that is not a camera emulator is E_CAMERA_DEVICE and says to claim with --camera", async () => {
		for (const p of ["pixel-10", undefined]) {
			profile = p;
			const r = await camera()({});
			expect(r.success).toBe(false);
			if (!r.success) {
				expect(r.error.code).toBe("E_CAMERA_DEVICE");
				expect(r.error.message).toContain("--camera");
			}
		}
		expect(relaunches).toBe(0);
	});

	test("a png image is copied over <facing>.png: no sips, no restart, applies on the next camera open", async () => {
		const png = Buffer.concat([PNG_MAGIC, Buffer.from("scene")]);
		const path = file("scene.png", png);
		const feeds: CameraCondition = { back: { kind: "image", path } };
		const r = await camera()(feeds);
		expect(r).toEqual({ success: true, data: { feeds, appliesOnCameraOpen: true, rebooted: false } });
		expect(readFileSync(join(feedDir(), "back.png")).equals(png)).toBe(true);
		expect(sips).toEqual([]);
		expect(relaunches).toBe(0);
		expect(recorded).toEqual([feeds]);
	});

	test("a facing left out goes back to the grey placeholder", async () => {
		writeFileSync(join(feedDir(), "front.png"), "old scene");
		await camera()({ back: { kind: "image", path: file("a.png", PNG_MAGIC) } });
		expect(readFileSync(join(feedDir(), "front.png")).equals(PLACEHOLDER_PNG)).toBe(true);
	});

	test("a jpeg is re-encoded to png through sips (never renamed), via a temp file renamed into place", async () => {
		const path = file("photo.jpg", JPEG);
		const r = await camera()({ front: { kind: "image", path } });
		expect(r.success).toBe(true);
		expect(sips).toHaveLength(1);
		expect(sips[0]?.slice(0, 5)).toEqual(["sips", "-s", "format", "png", path]);
		expect(sips[0]?.[5]).toBe("--out");
		const tmp = sips[0]?.[6] ?? "";
		expect(tmp.startsWith(feedDir())).toBe(true);
		expect(readFileSync(join(feedDir(), "front.png")).subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
		expect(existsSync(tmp)).toBe(false);
		expect(readdirSync(feedDir()).sort()).toEqual(["back.png", "front.png"]);
	});

	test("a failing sips is E_IO and leaves the feeds as they were", async () => {
		const failing: Exec = async () => ({ exitCode: 13, stdout: "", stderr: "Error: not an image" });
		const r = await camera({ exec: failing })({ back: { kind: "image", path: file("x.jpg", JPEG) } });
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.code).toBe("E_IO");
		expect(readFileSync(join(feedDir(), "back.png")).equals(PLACEHOLDER_PNG)).toBe(true);
		expect(recorded).toEqual([]);
	});

	test("null takes every feed off: placeholders, no restart when already in image mode", async () => {
		await camera()({ back: { kind: "image", path: file("a.png", PNG_MAGIC) } });
		const r = await camera()(null);
		expect(r).toEqual({ success: true, data: { feeds: {}, appliesOnCameraOpen: true, rebooted: false } });
		expect(readFileSync(join(feedDir(), "back.png")).equals(PLACEHOLDER_PNG)).toBe(true);
		expect(relaunches).toBe(0);
		expect(recorded.at(-1)).toEqual({});
	});

	test("a video feed records the mode, stages <facing>.<ext>, restarts the emulator and reports rebooted", async () => {
		const path = file("scene.mp4", MP4);
		const feeds: CameraCondition = { back: { kind: "video", path, loop: true } };
		const r = await camera()(feeds);
		expect(r).toEqual({ success: true, data: { feeds, rebooted: true } });
		expect(JSON.parse(readFileSync(join(feedDir(), "mode.json"), "utf8"))).toEqual({ back: "back.mp4" });
		expect(readFileSync(join(feedDir(), "back.mp4")).equals(MP4)).toBe(true);
		expect(relaunches).toBe(1);
		expect(recorded).toEqual([feeds]);
	});

	test("the same video again needs no restart (the file is re-read per camera open)", async () => {
		const feeds: CameraCondition = { back: { kind: "video", path: file("scene.mp4", MP4), loop: true } };
		await camera()(feeds);
		const again = await camera()(feeds);
		expect(again).toEqual({ success: true, data: { feeds, appliesOnCameraOpen: true, rebooted: false } });
		expect(relaunches).toBe(1);
	});

	test("video to image restarts again, removes the video and the mode file", async () => {
		await camera()({ back: { kind: "video", path: file("scene.mp4", MP4), loop: true } });
		const r = await camera()({ back: { kind: "image", path: file("a.png", PNG_MAGIC) } });
		expect(r.success && r.data.rebooted).toBe(true);
		expect(relaunches).toBe(2);
		expect(existsSync(join(feedDir(), "mode.json"))).toBe(false);
		expect(existsSync(join(feedDir(), "back.mp4"))).toBe(false);
	});

	test("a restart that fails is E_NOT_BOOTED with the reason", async () => {
		relaunchResult = { success: false, error: "did not shut down" };
		const r = await camera()({ back: { kind: "video", path: file("scene.mp4", MP4), loop: true } });
		expect(r.success).toBe(false);
		if (!r.success) {
			expect(r.error.code).toBe("E_NOT_BOOTED");
			expect(r.error.message).toContain("did not shut down");
		}
	});

	test("a video feed whose file is an image is E_BAD_REQUEST", async () => {
		const r = await camera()({ back: { kind: "video", path: file("x.png", PNG_MAGIC), loop: true } });
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.code).toBe("E_BAD_REQUEST");
		expect(relaunches).toBe(0);
	});
});
