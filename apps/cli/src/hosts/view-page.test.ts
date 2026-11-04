import { describe, expect, test } from "bun:test";
import { allowedRequest, parseViewInput, pngSize, toDevicePoint, viewPageHtml } from "./view-page";

function png(width: number, height: number): Uint8Array {
	const b = new Uint8Array(24);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	const v = new DataView(b.buffer);
	v.setUint32(16, width);
	v.setUint32(20, height);
	return b;
}

describe("pngSize", () => {
	test("reads IHDR, refuses anything that is not a PNG", () => {
		expect(pngSize(png(390, 844))).toEqual({ width: 390, height: 844 });
		expect(pngSize(new Uint8Array(24))).toBeUndefined();
		expect(pngSize(new Uint8Array(3))).toBeUndefined();
	});
});

describe("toDevicePoint", () => {
	test("a 0..1 point on the frame lands on the device's own coordinates, clamped", () => {
		expect(toDevicePoint({ x: 0.5, y: 0.25 }, { width: 390, height: 844 })).toEqual({ x: 195, y: 211 });
		expect(toDevicePoint({ x: 2, y: -1 }, { width: 390, height: 844 })).toEqual({ x: 390, y: 0 });
	});
});

describe("allowedRequest", () => {
	const base = { token: "abc", port: 4000 };
	const req = (path: string, init: { method?: string; host?: string; origin?: string } = {}) =>
		new Request(`http://127.0.0.1:4000${path}`, {
			method: init.method ?? "GET",
			headers: {
				host: init.host ?? "127.0.0.1:4000",
				...(init.origin !== undefined ? { origin: init.origin } : {}),
			},
		});

	test("the token path on the loopback host; a POST only from the page itself", () => {
		expect(allowedRequest(req("/abc/frame"), base)).toBe("frame");
		expect(allowedRequest(req("/abc/"), base)).toBe("page");
		expect(allowedRequest(req("/abc/input", { method: "POST", origin: "http://127.0.0.1:4000" }), base)).toBe("input");
	});

	test("refused: wrong token, a rebinding Host, a cross-site POST, an unknown route", () => {
		expect(allowedRequest(req("/zzz/frame"), base)).toBeUndefined();
		expect(allowedRequest(req("/abc/frame", { host: "evil.example:4000" }), base)).toBeUndefined();
		expect(allowedRequest(req("/abc/input", { method: "POST", origin: "http://evil.example" }), base)).toBeUndefined();
		expect(allowedRequest(req("/abc/input", { method: "POST" }), base)).toBeUndefined();
		expect(allowedRequest(req("/abc/nope"), base)).toBeUndefined();
	});
});

describe("parseViewInput", () => {
	test("tap, swipe (duration clamped), type, key, home; anything else refused", () => {
		expect(parseViewInput({ kind: "tap", x: 0.1, y: 0.2 })).toEqual({ kind: "tap", x: 0.1, y: 0.2 });
		expect(parseViewInput({ kind: "swipe", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, durationMs: 9_999 })).toEqual({
			kind: "swipe",
			from: { x: 0, y: 0 },
			to: { x: 1, y: 1 },
			durationMs: 2_000,
		});
		expect(parseViewInput({ kind: "type", text: "a" })).toEqual({ kind: "type", text: "a" });
		expect(parseViewInput({ kind: "key", key: "Enter" })).toEqual({ kind: "key", key: "Enter" });
		expect(parseViewInput({ kind: "home" })).toEqual({ kind: "home" });
		expect(parseViewInput({ kind: "key", key: "Escape" })).toBeUndefined();
		expect(parseViewInput({ kind: "tap", x: "1", y: 0 })).toBeUndefined();
		expect(parseViewInput({ kind: "shell", cmd: "rm" })).toBeUndefined();
		expect(parseViewInput(null)).toBeUndefined();
	});
});

describe("viewPageHtml", () => {
	test("escapes the title; watch mode sends no input", () => {
		const html = viewPageHtml({ title: "<iPhone> & co", watch: true });
		expect(html).toContain("&#60;iPhone&#62; &#38; co");
		expect(html).toContain("const watch=true");
	});
});
