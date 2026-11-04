import { afterEach, describe, expect, test } from "bun:test";
import type { Point } from "@delacour/warden-e2e/driver/driver.types";
import { type HostView, serveHostView, type ViewDriver } from "./view";

const views: HostView[] = [];
afterEach(() => {
	for (const v of views.splice(0)) v.stop();
});

function png(width: number, height: number): Uint8Array {
	const b = new Uint8Array(24);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	new DataView(b.buffer).setUint32(16, width);
	new DataView(b.buffer).setUint32(20, height);
	return b;
}

function fakeDriver() {
	const calls: string[] = [];
	let shots = 0;
	const ok = <T>(data: T) => Promise.resolve({ success: true as const, data });
	const driver: ViewDriver = {
		screenshot: async () => {
			shots++;
			await Bun.sleep(20);
			return { success: true, data: { png: png(195, 422) } };
		},
		snapshot: () =>
			ok({
				platform: "ios" as const,
				backend: "ax" as const,
				takenAt: 0,
				screen: { width: 390, height: 844, scale: 3 },
				elements: [],
				flat: [],
				truncated: false,
			}),
		tap: (p: Point) => {
			calls.push(`tap ${p.x},${p.y}`);
			return ok(undefined);
		},
		swipe: (a: Point, b: Point) => {
			calls.push(`swipe ${a.x},${a.y}>${b.x},${b.y}`);
			return ok(undefined);
		},
		typeText: (t: string) => {
			calls.push(`type ${t}`);
			return ok(undefined);
		},
		key: (k) => {
			calls.push(`key ${k}`);
			return ok(undefined);
		},
		pressButton: (b) => {
			calls.push(`button ${b}`);
			return ok(undefined);
		},
	};
	return { driver, calls, shots: () => shots };
}

const post = (view: HostView, body: unknown) =>
	fetch(`${view.url}input`, {
		method: "POST",
		headers: { origin: `http://127.0.0.1:${view.port}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});

describe("serveHostView", () => {
	test("the page, frames (concurrent requests share one screenshot), input mapped to device coordinates", async () => {
		const f = fakeDriver();
		const view = serveHostView({ driver: f.driver, title: "iPhone 16 · mac", watch: false });
		views.push(view);
		expect(view.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32,}\/$/);
		const page = await fetch(view.url);
		expect(await page.text()).toContain("iPhone 16 · mac");
		const [a, b] = await Promise.all([fetch(`${view.url}frame`), fetch(`${view.url}frame`)]);
		expect(a.headers.get("content-type")).toBe("image/png");
		expect((await a.arrayBuffer()).byteLength).toBe(24);
		expect((await b.arrayBuffer()).byteLength).toBe(24);
		expect(f.shots()).toBe(1);
		expect((await post(view, { kind: "tap", x: 0.5, y: 0.5 })).status).toBe(204);
		expect(
			(await post(view, { kind: "swipe", from: { x: 0.5, y: 0.9 }, to: { x: 0.5, y: 0.1 }, durationMs: 300 })).status
		).toBe(204);
		expect((await post(view, { kind: "key", key: "Enter" })).status).toBe(204);
		expect((await post(view, { kind: "home" })).status).toBe(204);
		expect(f.calls).toEqual(["tap 195,422", "swipe 195,760>195,84", "key Enter", "button home"]);
	});

	test("watch: input is refused (403) and never reaches the driver; bad bodies are 400; no token is 404", async () => {
		const f = fakeDriver();
		const view = serveHostView({ driver: f.driver, title: "x", watch: true });
		views.push(view);
		expect((await post(view, { kind: "tap", x: 0.5, y: 0.5 })).status).toBe(403);
		expect(f.calls).toEqual([]);
		const rw = serveHostView({ driver: f.driver, title: "x", watch: false });
		views.push(rw);
		expect((await post(rw, { kind: "rm" })).status).toBe(400);
		expect((await fetch(`http://127.0.0.1:${rw.port}/frame`)).status).toBe(404);
	});

	test("a frame failure is a 502 with the driver's message", async () => {
		const f = fakeDriver();
		f.driver.screenshot = async () => ({
			success: false,
			error: { code: "E_TIMEOUT", message: "no frame", retryable: true },
		});
		const view = serveHostView({ driver: f.driver, title: "x", watch: false });
		views.push(view);
		const r = await fetch(`${view.url}frame`);
		expect(r.status).toBe(502);
		expect(await r.text()).toContain("no frame");
	});
});
