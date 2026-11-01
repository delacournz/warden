export type StreamEngine = "native" | "webview";

/**
 * Which receiver plays the stream. WebKit's WebRTC receiver never assembles a frame of Revyl's
 * H264 (SPS/PPS sent as their own same-timestamp frame), so WebKit gets the native path: Rust
 * receives, WebCodecs decodes. Chromium (WebView2 on Windows) plays it fine itself.
 */
export function streamEngine(userAgent: string, hasWebCodecs: boolean): StreamEngine {
	if (!hasWebCodecs) return "webview";
	return /Chrome\//.test(userAgent) ? "webview" : "native";
}
