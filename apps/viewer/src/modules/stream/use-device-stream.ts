import { useRef } from "react";
import { demoDevice } from "./demo-device.ts";
import { startNativeSession } from "./native-session.ts";
import { streamEngine } from "./stream-engine.ts";
import { useDemoStream } from "./use-demo-stream.ts";
import { useWhep } from "./use-whep.ts";

const ENGINE = streamEngine(navigator.userAgent);

/** Dev builds only: `VITE_DEMO_DEVICE=iphone-17-pro-max` swaps the stream for a test pattern. */
const DEMO = import.meta.env.DEV ? demoDevice(import.meta.env.VITE_DEMO_DEVICE) : null;
const DEMO_SIZE = DEMO ?? { width: 1, height: 1 };

/**
 * The device stream into a `<video>` on whichever receiver this webview needs (`stream-engine.ts`):
 * the native path (Rust receives and re-publishes on loopback) or the webview's own WebRTC to
 * Revyl. In demo mode a `<canvas>` gets a local test pattern and nothing connects; render the
 * canvas when `demo`, else the video.
 */
export function useDeviceStream(enabled: boolean) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const live = enabled && DEMO === null;
	const native = ENGINE === "native";
	const webview = useWhep(videoRef, live && !native);
	const nativeStream = useWhep(videoRef, live && native, startNativeSession);
	const demo = useDemoStream(canvasRef, enabled && DEMO !== null, DEMO_SIZE);
	const stream = DEMO !== null ? demo : native ? nativeStream : webview;
	return { demo: DEMO !== null, videoRef, canvasRef, ...stream };
}
