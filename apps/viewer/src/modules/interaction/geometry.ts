/** Pure geometry for the interaction layer: letterbox fit, device points, multi-touch mirror. */

export type Rect = { left: number; top: number; width: number; height: number };
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

/** The rectangle a picture occupies inside its `object-fit: contain` box, in client px. */
export function pictureFit(box: Rect, picture: Size): Rect | null {
	if (picture.width <= 0 || picture.height <= 0 || box.width <= 0 || box.height <= 0) return null;
	const scale = Math.min(box.width / picture.width, box.height / picture.height);
	const width = picture.width * scale;
	const height = picture.height * scale;
	return {
		left: box.left + (box.width - width) / 2,
		top: box.top + (box.height - height) / 2,
		width,
		height,
	};
}

/** Whether the device is shown upright (portrait) or turned (landscape). */
export type DisplayOrientation = "portrait" | "landscape";

/**
 * Which coordinate space the device expects touches in while landscape. Revyl's frame stays
 * portrait with the content turned inside it, so "native" sends the portrait point under the
 * pointer; "rotated" sends the landscape point as displayed. Flip after a hands-on check.
 */
export type LandscapeTouchSpace = "native" | "rotated";
export const LANDSCAPE_TOUCH_SPACE: LandscapeTouchSpace = "native";

/** The picture as the user sees it: landscape shows the portrait frame turned a quarter. */
export function displayPicture(picture: Size, orientation: DisplayOrientation): Size {
	return orientation === "landscape" ? { width: picture.height, height: picture.width } : picture;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Map a client point to device points (`device` is the portrait point size, not the picture's
 * pixels). In landscape the picture is displayed turned counter-clockwise, so the point is
 * un-rotated into portrait points ("native") or kept in display axes ("rotated"). Null outside
 * the visible picture; with `clamp` an outside point lands on the nearest edge.
 */
export function toInteractionPoint(
	clientX: number,
	clientY: number,
	box: Rect,
	picture: Size,
	device: Size,
	options: { clamp?: boolean; orientation?: DisplayOrientation; space?: LandscapeTouchSpace } = {}
): Point | null {
	const orientation = options.orientation ?? "portrait";
	const fit = pictureFit(box, displayPicture(picture, orientation));
	if (!fit || device.width <= 0 || device.height <= 0) return null;
	const fx = (clientX - fit.left) / fit.width;
	const fy = (clientY - fit.top) / fit.height;
	if (!options.clamp && (fx < 0 || fx > 1 || fy < 0 || fy > 1)) return null;
	const cx = clamp(fx, 0, 1);
	const cy = clamp(fy, 0, 1);
	const space = options.space ?? LANDSCAPE_TOUCH_SPACE;
	if (orientation === "landscape" && space === "rotated")
		return scaled(cx, cy, { width: device.height, height: device.width });
	if (orientation === "landscape") return scaled(1 - cy, cx, device);
	return scaled(cx, cy, device);
}

function scaled(fx: number, fy: number, size: Size): Point {
	return {
		x: clamp(Math.round(fx * size.width), 0, size.width - 1),
		y: clamp(Math.round(fy * size.height), 0, size.height - 1),
	};
}

/** The second finger of an Alt gesture: the first one reflected through the picture centre. */
export function mirrorThroughCentre(point: Point, fit: Rect): Point {
	const cx = fit.left + fit.width / 2;
	const cy = fit.top + fit.height / 2;
	return { x: 2 * cx - point.x, y: 2 * cy - point.y };
}

export type ZoomDirection = "zoom_in" | "zoom_out";

/** Fingers moving away from the centre zoom in; equal distance counts as in. */
export function zoomDirection(startDistance: number, endDistance: number): ZoomDirection {
	return endDistance >= startDistance ? "zoom_in" : "zoom_out";
}
