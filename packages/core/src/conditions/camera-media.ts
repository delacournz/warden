import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CameraFacing, CameraFeed } from "./conditions.types";

export type CameraMediaKind = CameraFeed["kind"];
export type CameraMediaExt = "png" | "jpg" | "heic" | "mp4" | "mov";
export type CameraMediaError = { code: "E_CAMERA_NOT_FOUND" | "E_CAMERA_MEDIA"; message: string };

const SUPPORTED = "png, jpg, heic, mp4, mov";

/** `ftyp` major brands: ISO-BMFF covers HEIC images and MP4 / MOV video, told apart by the brand. */
const FTYP_BRANDS: Record<string, { kind: CameraMediaKind; ext: CameraMediaExt }> = {
	heic: { kind: "image", ext: "heic" },
	heix: { kind: "image", ext: "heic" },
	mif1: { kind: "image", ext: "heic" },
	"qt  ": { kind: "video", ext: "mov" },
	isom: { kind: "video", ext: "mp4" },
	iso2: { kind: "video", ext: "mp4" },
	mp41: { kind: "video", ext: "mp4" },
	mp42: { kind: "video", ext: "mp4" },
	avc1: { kind: "video", ext: "mp4" },
	M4V: { kind: "video", ext: "mp4" },
	"M4V ": { kind: "video", ext: "mp4" },
};

function head(path: string, n: number): Buffer {
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(n);
		const read = readSync(fd, buf, 0, n, 0);
		return buf.subarray(0, read);
	} finally {
		closeSync(fd);
	}
}

/** The kind of a camera asset from its leading bytes (the extension is ignored): png / jpg / heic image, mp4 / mov video. */
export function sniffCameraMedia(
	path: string
): Result<{ kind: CameraMediaKind; ext: CameraMediaExt }, CameraMediaError> {
	if (!existsSync(path)) {
		return { success: false, error: { code: "E_CAMERA_NOT_FOUND", message: `camera media not found: ${path}` } };
	}
	const b = head(path, 12);
	if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return ok({ kind: "image", ext: "png" });
	}
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ok({ kind: "image", ext: "jpg" });
	if (b.length >= 12 && b.subarray(4, 8).toString("latin1") === "ftyp") {
		const brand = FTYP_BRANDS[b.subarray(8, 12).toString("latin1")];
		if (brand) return ok(brand);
	}
	return {
		success: false,
		error: { code: "E_CAMERA_MEDIA", message: `unsupported camera media ${path}: use ${SUPPORTED}` },
	};
}

/** Where a device's staged camera feeds live; the simulator / emulator reads them straight off the host filesystem. */
export function cameraFeedDir(wardenHome: string, udid: string): string {
	return join(wardenHome, "camera", udid);
}

export type StageCameraFeedInput = {
	wardenHome: string;
	udid: string;
	facing: CameraFacing;
	source: string;
	/** video only: play again from the start at the end (default true where the caller has no opinion) */
	loop: boolean;
};

/**
 * Copy a camera asset to `<camera dir>/<facing>-<content hash>.<ext>`. The name changes with the content, so a
 * consumer that compares paths (the iOS dylib, the Android swap) sees every new asset as new.
 */
export function stageCameraFeed(input: StageCameraFeedInput): Result<CameraFeed, CameraMediaError> {
	const sniffed = sniffCameraMedia(input.source);
	if (!sniffed.success) return sniffed;
	const hash = createHash("sha256").update(readFileSync(input.source)).digest("hex").slice(0, 12);
	const dir = cameraFeedDir(input.wardenHome, input.udid);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${input.facing}-${hash}.${sniffed.data.ext}`);
	if (!existsSync(path)) copyFileSync(input.source, path);
	return ok(sniffed.data.kind === "image" ? { kind: "image", path } : { kind: "video", path, loop: input.loop });
}

/** Remove every staged feed of a device (release / reset). Missing dir is fine. */
export function clearCameraFeeds(wardenHome: string, udid: string): void {
	rmSync(cameraFeedDir(wardenHome, udid), { recursive: true, force: true });
}
