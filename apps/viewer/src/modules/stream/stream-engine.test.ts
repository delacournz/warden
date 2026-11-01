import { describe, expect, test } from "bun:test";
import { streamEngine } from "./stream-engine.ts";

const WKWEBVIEW = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WEBVIEW2 =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

describe("streamEngine", () => {
	test("WebKit (macOS WKWebView) decodes natively", () => {
		expect(streamEngine(WKWEBVIEW, true)).toBe("native");
	});

	test("Chromium (Windows WebView2) keeps its own WebRTC receiver", () => {
		expect(streamEngine(WEBVIEW2, true)).toBe("webview");
	});

	test("without WebCodecs there is no native path", () => {
		expect(streamEngine(WKWEBVIEW, false)).toBe("webview");
	});
});
