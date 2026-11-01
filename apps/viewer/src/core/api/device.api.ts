import { Channel, invoke } from "@tauri-apps/api/core";

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
export const nativeStreamStart = (channel: Channel<string>) => call<void>("native_stream_start", { channel });
/** Answer the webview's recvonly offer for the loopback re-publish of the native stream. */
export const localStreamAnswer = (offer: string) => call<{ sdp: string }>("local_stream_answer", { offer });
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

/** One STUN/TURN server from the stream endpoint's `iceServers`. Empty when the API sends none. */
export type IceServer = { urls: string[]; username?: string; credential?: string };
export const streamIceServers = () => call<IceServer[]>("stream_ice_servers");

export type TouchPhase = "down" | "move" | "up";
export type TouchGesture = "tap" | "drag" | "long_press";
export type PinchGesture = "zoom_in" | "zoom_out";
export type Orientation = "portrait" | "landscape";
export type TouchPoint = { id: number; x: number; y: number };

/** A client frame for the live input socket. `id` is echoed in the server's acks. */
export type InputFrame =
	| { type: "touch"; id?: string; phase: TouchPhase; x: number; y: number; durationMs?: number; gesture?: TouchGesture }
	| { type: "multiTouch"; id?: string; phase: TouchPhase; touches: TouchPoint[]; gesture?: PinchGesture }
	| { type: "goHome"; id?: string }
	| { type: "shake"; id?: string }
	| { type: "orientation"; id?: string; orientation: Orientation }
	| { type: "openUrl"; id?: string; url: string }
	| { type: "location"; id?: string; latitude: number; longitude: number }
	| { type: "input"; id?: string; text: string; clearFirst?: boolean; paste?: boolean }
	| { type: "key"; id?: string; key: DeviceKey };

/** A server frame; `closed` is also sent by Rust when the socket drops. */
export type InputEvent =
	| { type: "ready" }
	| { type: "ack"; id: string; status: "received" | "done" }
	| { type: "error"; code: string; message: string; id?: string }
	| { type: "closed"; reason: string };

/** Open this window's input socket (drive scope). Events arrive on `onEvent` until `closed`. */
export const inputConnect = (onEvent: (event: InputEvent) => void) => {
	const channel = new Channel<InputEvent>();
	channel.onmessage = onEvent;
	return call<void>("input_connect", { channel });
};
export const inputSend = (frame: InputFrame) => call<void>("input_send", { frame });
export const inputClose = () => call<void>("input_close");
