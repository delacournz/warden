import { describe, expect, test } from "bun:test";
import {
	displayPicture,
	LANDSCAPE_TOUCH_SPACE,
	mirrorThroughCentre,
	pictureFit,
	toInteractionPoint,
	zoomDirection,
} from "./geometry.ts";

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

describe("landscape orientation", () => {
	const landscapeBox = { left: 0, top: 0, width: 956, height: 440 };

	test("displayPicture swaps the picture in landscape only", () => {
		expect(displayPicture(picture, "portrait")).toEqual(picture);
		expect(displayPicture(picture, "landscape")).toEqual({ width: 2868, height: 1320 });
	});

	test("native space un-rotates the counter-clockwise picture into portrait points", () => {
		const opts = { orientation: "landscape" as const, space: "native" as const };
		expect(toInteractionPoint(0, 0, landscapeBox, picture, device, opts)).toEqual({ x: 439, y: 0 });
		expect(toInteractionPoint(0, 440, landscapeBox, picture, device, opts)).toEqual({ x: 0, y: 0 });
		expect(toInteractionPoint(956, 0, landscapeBox, picture, device, opts)).toEqual({ x: 439, y: 955 });
		expect(toInteractionPoint(956, 440, landscapeBox, picture, device, opts)).toEqual({ x: 0, y: 955 });
		expect(toInteractionPoint(478, 220, landscapeBox, picture, device, opts)).toEqual({ x: 220, y: 478 });
	});

	test("native space maps a point a quarter along the top edge to a quarter down the right edge", () => {
		const opts = { orientation: "landscape" as const, space: "native" as const };
		expect(toInteractionPoint(239, 0, landscapeBox, picture, device, opts)).toEqual({ x: 439, y: 239 });
	});

	test("rotated space keeps display axes in landscape points", () => {
		const opts = { orientation: "landscape" as const, space: "rotated" as const };
		expect(toInteractionPoint(0, 0, landscapeBox, picture, device, opts)).toEqual({ x: 0, y: 0 });
		expect(toInteractionPoint(956, 440, landscapeBox, picture, device, opts)).toEqual({ x: 955, y: 439 });
		expect(toInteractionPoint(478, 220, landscapeBox, picture, device, opts)).toEqual({ x: 478, y: 220 });
	});

	test("letterbox bars outside the rotated picture are ignored", () => {
		const wide = { left: 0, top: 0, width: 1200, height: 440 };
		const opts = { orientation: "landscape" as const, space: "native" as const };
		expect(toInteractionPoint(5, 100, wide, picture, device, opts)).toBeNull();
		expect(toInteractionPoint(5, 100, wide, picture, device, { ...opts, clamp: true })).not.toBeNull();
	});

	test("the default space is the exported constant", () => {
		expect(LANDSCAPE_TOUCH_SPACE).toBe("native");
		const explicit = toInteractionPoint(100, 100, landscapeBox, picture, device, {
			orientation: "landscape",
			space: LANDSCAPE_TOUCH_SPACE,
		});
		expect(toInteractionPoint(100, 100, landscapeBox, picture, device, { orientation: "landscape" })).toEqual(explicit);
	});
});
