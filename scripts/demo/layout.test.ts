import { describe, expect, test } from "bun:test";
import { computeLayout, coverage, renderTopLayer, renderUnderlay } from "./layout";

const opts = { width: 1920, phones: 5, phoneAspect: 1206 / 2622, terminalAspect: 1200 / 300 };

describe("computeLayout", () => {
	const l = computeLayout(opts);

	test("even canvas and screen sizes (yuv420p)", () => {
		expect(l.width % 2).toBe(0);
		expect(l.height % 2).toBe(0);
		for (const p of l.phones) {
			expect(p.screen.w % 2).toBe(0);
			expect(p.screen.h % 2).toBe(0);
		}
	});

	test("phones keep the recording aspect and fit inside the margins without overlap", () => {
		const first = l.phones[0];
		const last = l.phones.at(-1);
		if (!first || !last) throw new Error("no phones");
		expect(first.screen.w / first.screen.h).toBeCloseTo(opts.phoneAspect, 2);
		expect(first.bezel.x).toBeGreaterThanOrEqual(l.margin);
		expect(last.bezel.x + last.bezel.w).toBeLessThanOrEqual(l.width - l.margin);
		for (let i = 1; i < l.phones.length; i++) {
			const a = l.phones[i - 1];
			const b = l.phones[i];
			if (a && b) expect(b.bezel.x).toBeGreaterThan(a.bezel.x + a.bezel.w);
		}
	});

	test("terminal pane sits under the labels, inside the card", () => {
		const phone = l.phones[0];
		if (!phone) throw new Error("no phones");
		expect(l.card.y).toBeGreaterThan(phone.jobY + l.jobSize);
		expect(l.terminal.x).toBeGreaterThanOrEqual(l.card.x);
		expect(l.terminal.y + l.terminal.h).toBeLessThanOrEqual(l.card.y + l.card.h);
		expect(l.terminal.w / l.terminal.h).toBeCloseTo(opts.terminalAspect, 1);
		expect(l.height).toBeGreaterThanOrEqual(l.card.y + l.card.h);
	});

	test("a tall terminal is capped and centred", () => {
		const tall = computeLayout({ ...opts, terminalAspect: 1 });
		expect(tall.terminal.h).toBeLessThanOrEqual(360);
		expect(tall.terminal.x + tall.terminal.w / 2).toBeCloseTo(tall.card.x + tall.card.w / 2, -1);
	});
});

describe("coverage", () => {
	const r = { x: 0, y: 0, w: 100, h: 100 };
	test("full inside, empty outside, zero in a rounded corner", () => {
		expect(coverage(50, 50, r, 20)).toBe(1);
		expect(coverage(150, 50, r, 20)).toBe(0);
		expect(coverage(0, 0, r, 20)).toBe(0);
		expect(coverage(0, 50, r, 20)).toBeGreaterThan(0.9);
	});
});

describe("layers", () => {
	const l = computeLayout({ ...opts, width: 480 });
	const px = (buf: Uint8Array, x: number, y: number) =>
		Array.from(buf.slice((y * l.width + x) * 4, (y * l.width + x) * 4 + 4));
	const phone = l.phones[0];
	if (!phone) throw new Error("no phones");

	test("underlay is opaque ground", () => {
		expect(px(renderUnderlay(l), 0, 0)).toEqual([0, 0, 0, 255]);
	});

	test("top layer is clear over the screen centre and opaque bezel on the screen's corner", () => {
		const top = renderTopLayer(l);
		const cx = phone.screen.x + phone.screen.w / 2;
		const cy = phone.screen.y + phone.screen.h / 2;
		expect(px(top, cx, cy)[3]).toBe(0);
		expect(px(top, phone.screen.x, phone.screen.y)[3]).toBe(255);
		expect(px(top, 0, 0)[3]).toBe(0);
	});
});
