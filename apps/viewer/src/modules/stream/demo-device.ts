import type { VideoSize } from "./use-whep.ts";

/** Screen sizes in device pixels, portrait. */
const PRESETS: Record<string, VideoSize> = {
	"iphone-17-pro-max": { width: 1320, height: 2868 },
	"iphone-17-pro": { width: 1206, height: 2622 },
	"iphone-17": { width: 1206, height: 2622 },
	"iphone-se": { width: 750, height: 1334 },
	"ipad-pro-13": { width: 2064, height: 2752 },
	"pixel-9-pro-xl": { width: 1344, height: 2992 },
};

/**
 * The demo device for a `VITE_DEMO_DEVICE` value: a preset name (case-insensitive) or `WxH` in
 * pixels. Anything else, or unset, means no demo.
 */
export function demoDevice(value: string | undefined): VideoSize | null {
	const key = value?.trim().toLowerCase();
	if (!key) return null;
	const preset = PRESETS[key];
	if (preset) return preset;
	const match = /^(\d+)x(\d+)$/.exec(key);
	if (!match) return null;
	const width = Number(match[1]);
	const height = Number(match[2]);
	return width > 0 && height > 0 ? { width, height } : null;
}

export function rotated(size: VideoSize): VideoSize {
	return { width: size.height, height: size.width };
}
