import { describe, expect, test } from "bun:test";
import { mirrorThroughCentre, pictureFit, toInteractionPoint, zoomDirection } from "./geometry.ts";

const device = { width: 440, height: 956 };
const picture = { width: 1320, height: 2868 };

describe("pictureFit", () => {
	test("letterboxes a tall picture inside a wide box", () => {
		const fit = pictureFit({ left: 10, top: 20, width: 600, height: 478 }, picture);
		expect(fit?.height).toBeCloseTo(478);
		expect(fit?.width).toBeCloseTo(478 * (1320 / 2868));
		expect((fit?.left ?? 0) - 10).toBeCloseTo((600 - (fit?.width ?? 0)) / 2);
		expect(fit?.top).toBe(20);
	});

	test("null for an empty picture or box", () => {
		expect(pictureFit({ left: 0, top: 0, width: 0, height: 10 }, picture)).toBeNull();
		expect(pictureFit({ left: 0, top: 0, width: 10, height: 10 }, { width: 0, height: 0 })).toBeNull();
	});
});

describe("toInteractionPoint", () => {
	const box = { left: 0, top: 0, width: 440, height: 956 };

	test("maps the centre and corners to device points", () => {
		expect(toInteractionPoint(220, 478, box, picture, device)).toEqual({ x: 220, y: 478 });
		expect(toInteractionPoint(0, 0, box, picture, device)).toEqual({ x: 0, y: 0 });
		expect(toInteractionPoint(440, 956, box, picture, device)).toEqual({ x: 439, y: 955 });
	});

	test("ignores presses in the letterbox bars", () => {
		const wide = { left: 0, top: 0, width: 1000, height: 956 };
		expect(toInteractionPoint(10, 100, wide, picture, device)).toBeNull();
		expect(toInteractionPoint(990, 100, wide, picture, device)).toBeNull();
		expect(toInteractionPoint(500, 100, wide, picture, device)).not.toBeNull();
	});

	test("clamp pins an outside point to the picture edge", () => {
		const wide = { left: 0, top: 0, width: 1000, height: 956 };
		expect(toInteractionPoint(0, -50, wide, picture, device, { clamp: true })).toEqual({ x: 0, y: 0 });
		expect(toInteractionPoint(2000, 5000, wide, picture, device, { clamp: true })).toEqual({ x: 439, y: 955 });
	});

	test("uses the box offset", () => {
		const offset = { left: 100, top: 50, width: 440, height: 956 };
		expect(toInteractionPoint(320, 528, offset, picture, device)).toEqual({ x: 220, y: 478 });
	});
});

describe("mirrorThroughCentre", () => {
	test("reflects a client point through the picture centre", () => {
		const fit = { left: 100, top: 0, width: 200, height: 400 };
		expect(mirrorThroughCentre({ x: 150, y: 100 }, fit)).toEqual({ x: 250, y: 300 });
		expect(mirrorThroughCentre({ x: 200, y: 200 }, fit)).toEqual({ x: 200, y: 200 });
	});
});

describe("zoomDirection", () => {
	test("zoom_in when the final distance from centre is at least the start", () => {
		expect(zoomDirection(40, 90)).toBe("zoom_in");
		expect(zoomDirection(40, 40)).toBe("zoom_in");
		expect(zoomDirection(90, 40)).toBe("zoom_out");
	});
});
