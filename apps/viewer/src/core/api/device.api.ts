import { type Channel, invoke } from "@tauri-apps/api/core";

export type Scope = "view" | "drive";
export type Platform = "ios" | "android";

/** Everything the window may know about the session. The token stays in Rust. */
export type ViewerInfo = {
	deviceId: string;
	scope: Scope;
	title: string;
	platform: Platform;
	expiresAt: string;
	detached: boolean;
	expired: boolean;
	hasBillingUrl: boolean;
};

export class DeviceError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "DeviceError";
		this.code = code;
	}
}

function toDeviceError(e: unknown): DeviceError {
	if (typeof e === "object" && e !== null && "code" in e && "message" in e) {
		return new DeviceError(String(e.code), String(e.message));
	}
	return new DeviceError("UNKNOWN", String(e));
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
	try {
		return await invoke<T>(command, args);
	} catch (e) {
		throw toDeviceError(e);
	}
}

export const viewerInfo = () => call<ViewerInfo>("viewer_info");
export const viewerStreaming = () => call<void>("viewer_streaming");
/** Exit the window; attached, `release` tells the CLI to stop the device and end the lease. */
export const closeViewer = (release: boolean) => call<void>("close_viewer", { release });
export const fitWindow = (aspect: number, chromeHeight: number, padX: number) =>
	call<void>("fit_window", { aspect, chromeHeight, padX });

export const whepOffer = (sdp: string) => call<{ sdp: string }>("whep_offer", { sdp });
export const whepClose = () => call<void>("whep_close");
export const nativeStreamStart = (channel: Channel<ArrayBuffer>) => call<void>("native_stream_start", { channel });
export const nativeStreamStop = () => call<void>("native_stream_stop");

export const tap = (x: number, y: number) => call<void>("tap", { x, y });
export type SwipeDirection = "up" | "down" | "left" | "right";
export type PinchScale = "zoom_in" | "zoom_out";
export type DeviceKey = "ENTER" | "BACKSPACE";
/** The size input coordinates are in; `units` says whether they are points or pixels. */
export type DeviceScreen = { width: number; height: number; units: "points" | "pixels" };

export const doubleTap = (x: number, y: number) => call<void>("double_tap", { x, y });
export const longPress = (x: number, y: number, durationMs?: number) => call<void>("long_press", { x, y, durationMs });
export const swipe = (args: { x: number; y: number; direction: SwipeDirection; durationMs?: number }) =>
	call<void>("swipe", args);
export const drag = (args: { fromX: number; fromY: number; toX: number; toY: number; durationMs?: number }) =>
	call<void>("drag", args);
export const pinch = (x: number, y: number, scale: PinchScale) => call<void>("pinch", { x, y, scale });
export const key = (key: DeviceKey) => call<void>("key", { key });
export const goHome = () => call<void>("go_home");
export const shake = () => call<void>("shake");
export const setLocation = (latitude: number, longitude: number) => call<void>("set_location", { latitude, longitude });
export const deviceScreen = () => call<DeviceScreen>("device_screen");
export const input = (text: string, clearFirst?: boolean) => call<void>("input", { text, clearFirst });
export const openUrl = (url: string) => call<void>("open_url", { url });
export const openBilling = () => call<void>("open_billing");
export const screenshot = () => call<string | null>("screenshot");
