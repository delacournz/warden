import { describe, expect, test } from "bun:test";
import { pictureStyle } from "./picture-style.ts";

describe("pictureStyle", () => {
	test("portrait needs no override", () => {
		expect(pictureStyle("portrait")).toBeUndefined();
	});

	test("landscape swaps the box and turns it counter-clockwise about the centre", () => {
		expect(pictureStyle("landscape")).toEqual({
			position: "absolute",
			left: "50%",
			top: "50%",
			width: "100cqh",
			height: "100cqw",
			transform: "translate(-50%, -50%) rotate(-90deg)",
		});
	});
});
