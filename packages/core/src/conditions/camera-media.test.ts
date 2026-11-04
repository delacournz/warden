import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { cameraFeedDir, clearCameraFeeds, sniffCameraMedia, stageCameraFeed } from "./camera-media";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const MOV = Buffer.from([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]);
const HEIC = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-cam-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function file(name: string, bytes: Buffer): string {
	const path = join(dir, name);
	writeFileSync(path, bytes);
	return path;
}

describe("sniffCameraMedia", () => {
	test("reads the kind from the bytes, not the extension", () => {
		expect(sniffCameraMedia(file("a.png", PNG))).toEqual({ success: true, data: { kind: "image", ext: "png" } });
		expect(sniffCameraMedia(file("a.jpg", JPEG))).toEqual({ success: true, data: { kind: "image", ext: "jpg" } });
		expect(sniffCameraMedia(file("a.heic", HEIC))).toEqual({ success: true, data: { kind: "image", ext: "heic" } });
		expect(sniffCameraMedia(file("a.mp4", MP4))).toEqual({ success: true, data: { kind: "video", ext: "mp4" } });
		expect(sniffCameraMedia(file("a.mov", MOV))).toEqual({ success: true, data: { kind: "video", ext: "mov" } });
		expect(sniffCameraMedia(file("renamed.mp4", PNG))).toEqual({
			success: true,
			data: { kind: "image", ext: "png" },
		});
	});

	test("E_CAMERA_NOT_FOUND for a missing file", () => {
		const r = sniffCameraMedia(join(dir, "nope.png"));
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.code).toBe("E_CAMERA_NOT_FOUND");
	});

	test("E_CAMERA_MEDIA for anything else", () => {
		const r = sniffCameraMedia(file("a.gif", Buffer.from("GIF89a......")));
		expect(r.success).toBe(false);
		if (!r.success) {
			expect(r.error.code).toBe("E_CAMERA_MEDIA");
			expect(r.error.message).toContain("png, jpg, heic, mp4, mov");
		}
	});
});

describe("stageCameraFeed", () => {
	test("copies to a content-hashed name under the device's camera dir", () => {
		const src = file("qr.png", PNG);
		const r = stageCameraFeed({ wardenHome: dir, udid: "U1", facing: "back", source: src, loop: true });
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data.kind).toBe("image");
		expect(r.data.path.startsWith(cameraFeedDir(dir, "U1"))).toBe(true);
		expect(basename(r.data.path)).toMatch(/^back-[0-9a-f]{12}\.png$/);
		expect(readFileSync(r.data.path)).toEqual(PNG);
	});

	test("video keeps loop; different content gets a different name", () => {
		const a = stageCameraFeed({
			wardenHome: dir,
			udid: "U1",
			facing: "front",
			source: file("a.mp4", MP4),
			loop: false,
		});
		const b = stageCameraFeed({ wardenHome: dir, udid: "U1", facing: "front", source: file("b.mov", MOV), loop: true });
		expect(a.success && a.data).toMatchObject({ kind: "video", loop: false });
		expect(b.success && b.data).toMatchObject({ kind: "video", loop: true });
		if (a.success && b.success) expect(a.data.path).not.toBe(b.data.path);
	});

	test("clearCameraFeeds removes the device's dir", () => {
		stageCameraFeed({ wardenHome: dir, udid: "U1", facing: "back", source: file("q.png", PNG), loop: true });
		clearCameraFeeds(dir, "U1");
		expect(existsSync(cameraFeedDir(dir, "U1"))).toBe(false);
		clearCameraFeeds(dir, "U1");
	});
});
