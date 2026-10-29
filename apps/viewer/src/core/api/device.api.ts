import { invoke } from "@tauri-apps/api/core";

export type Scope = "view" | "drive";
export type Platform = "ios" | "android";

/** Everything the window may know about the session. The token stays in Rust. */
export type ViewerInfo = {
	deviceId: string;
	scope: Scope;
	title: string;
	platform: Platform;
	expiresAt: string;
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
export const fitWindow = (aspect: number, chromeHeight: number) => call<void>("fit_window", { aspect, chromeHeight });

export const whepOffer = (sdp: string) => call<{ sdp: string }>("whep_offer", { sdp });
export const whepCandidate = (fragment: string) => call<void>("whep_candidate", { fragment });
export const whepClose = () => call<void>("whep_close");

export const tap = (x: number, y: number) => call<void>("tap", { x, y });
export const swipe = (fromX: number, fromY: number, toX: number, toY: number, durationMs?: number) =>
	call<void>("swipe", { fromX, fromY, toX, toY, durationMs });
export const input = (text: string, clearFirst?: boolean) => call<void>("input", { text, clearFirst });
export const openUrl = (url: string) => call<void>("open_url", { url });
export const screenshot = () => call<string | null>("screenshot");
