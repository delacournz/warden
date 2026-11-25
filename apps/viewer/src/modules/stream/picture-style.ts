import type { CSSProperties } from "react";
import type { DisplayOrientation } from "../interaction/geometry.ts";

/** Container style that makes `cqw`/`cqh` in `pictureStyle` resolve against the screen box. */
export const PICTURE_CONTAINER_STYLE: CSSProperties = { containerType: "size" };

/**
 * Inline style for the `<video>`/`<canvas>`. Revyl keeps the frame portrait when the device
 * rotates, with the landscape UI turned clockwise inside it. Landscape therefore lays the element
 * out swapped (the screen box's height as its width) and turns it -90° so the UI is upright, then
 * `object-fit: contain` letterboxes it inside the box as usual.
 */
export function pictureStyle(orientation: DisplayOrientation): CSSProperties | undefined {
	if (orientation === "portrait") return undefined;
	return {
		position: "absolute",
		left: "50%",
		top: "50%",
		width: "100cqh",
		height: "100cqw",
		transform: "translate(-50%, -50%) rotate(-90deg)",
	};
}
