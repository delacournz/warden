export type StreamEngine = "native" | "webview";

/**
 * Which receiver talks to Revyl. WebKit's WebRTC receiver never assembles a frame of Revyl's H264
 * (SPS/PPS sent as their own same-timestamp frame), so WebKit gets the native path: Rust receives
 * and re-publishes a spec-compliant stream on loopback. Chromium (WebView2 on Windows) plays
 * Revyl's stream fine itself.
 */
export function streamEngine(userAgent: string): StreamEngine {
	return /Chrome\//.test(userAgent) ? "webview" : "native";
}
