import { useRef } from "react";
import { demoDevice } from "./demo-device.ts";
import { streamEngine } from "./stream-engine.ts";
import { useDemoStream } from "./use-demo-stream.ts";
import { useNativeStream } from "./use-native-stream.ts";
import { useWhep } from "./use-whep.ts";

const ENGINE = streamEngine(navigator.userAgent, typeof VideoDecoder !== "undefined");

/** Dev builds only: `VITE_DEMO_DEVICE=iphone-17-pro-max` swaps the stream for a test pattern. */
const DEMO = import.meta.env.DEV ? demoDevice(import.meta.env.VITE_DEMO_DEVICE) : null;
const DEMO_SIZE = DEMO ?? { width: 1, height: 1 };

/**
 * The device stream on whichever receiver this webview needs (`stream-engine.ts`): a `<canvas>`
 * fed by the native path, or a `<video>` on the webview's own WebRTC. Render the element whose ref
 * matches `native`. In demo mode the canvas gets a local test pattern and nothing connects.
 */
export function useDeviceStream(enabled: boolean) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const native = DEMO !== null || ENGINE === "native";
	const webview = useWhep(videoRef, enabled && !native);
	const nativeStream = useNativeStream(canvasRef, enabled && native && DEMO === null);
	const demo = useDemoStream(canvasRef, enabled && DEMO !== null, DEMO_SIZE);
	const stream = DEMO !== null ? demo : native ? nativeStream : webview;
	return { native, demo: DEMO !== null, videoRef, canvasRef, ...stream };
}
