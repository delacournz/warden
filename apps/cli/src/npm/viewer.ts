import { err, ok, type Result } from "@delacour/warden-types/result";

/** Targets the `warden-viewer` desktop app ships for (WebKitGTK has no WebRTC, so no linux yet). */
export const VIEWER_TARGETS = ["darwin-arm64", "darwin-x64", "win32-x64"] as const;
export type ViewerTarget = (typeof VIEWER_TARGETS)[number];

/**
 * Where the viewer executable sits inside the extracted `warden-viewer-<target>.tgz`. The release job packs
 * its tarball so these paths resolve from the archive root.
 */
export const VIEWER_BINARY: Record<ViewerTarget, string> = {
	"darwin-arm64": "warden viewer.app/Contents/MacOS/warden-viewer",
	"darwin-x64": "warden viewer.app/Contents/MacOS/warden-viewer",
	"win32-x64": "warden-viewer.exe",
};

/** GitHub release asset for a target: a tarball with the layout of `VIEWER_BINARY`, listed in `SHA256SUMS`. */
export function viewerAsset(target: ViewerTarget): string {
	return `warden-viewer-${target}.tgz`;
}

function isViewerTarget(value: string): value is ViewerTarget {
	return VIEWER_TARGETS.some((target) => target === value);
}

/** `process.platform` + `process.arch` → viewer target, or the reason there is none. */
export function viewerTarget(platform: string, arch: string): Result<ViewerTarget> {
	const target = `${platform}-${arch}`;
	return isViewerTarget(target)
		? ok(target)
		: err(
				`warden view isn't available on ${platform}${platform === "linux" ? "" : `-${arch}`} yet (viewer builds: ${VIEWER_TARGETS.join(", ")})`
			);
}
