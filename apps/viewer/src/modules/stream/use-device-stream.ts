import { useRef } from "react";
import { streamEngine } from "./stream-engine.ts";
import { useNativeStream } from "./use-native-stream.ts";
import { useWhep } from "./use-whep.ts";

const ENGINE = streamEngine(navigator.userAgent, typeof VideoDecoder !== "undefined");

/**
 * The device stream on whichever receiver this webview needs (`stream-engine.ts`): a `<canvas>`
 * fed by the native path, or a `<video>` on the webview's own WebRTC. Render the element whose ref
 * matches `native`.
 */
export function useDeviceStream(enabled: boolean) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const native = ENGINE === "native";
	const webview = useWhep(videoRef, enabled && !native);
	const nativeStream = useNativeStream(canvasRef, enabled && native);
	return { native, videoRef, canvasRef, ...(native ? nativeStream : webview) };
}
