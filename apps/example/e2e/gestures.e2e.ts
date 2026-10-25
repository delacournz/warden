import { expect, type Screen, test } from "@delacour/warden-e2e";
import { ids } from "./helpers/ids";
import { pollUntil } from "./helpers/poll";
import { openGestures, SPEC_OPTIONS } from "./helpers/steps";

test.use(SPEC_OPTIONS);

/** Reads a numeric readout. */
async function readNumber(screen: Screen, testId: string): Promise<number> {
	return Number(await screen.getByTestId(testId).text());
}

/** Polls a numeric readout (they update after the gesture's onEnd) until `accept` likes it; returns the last value. */
function pollNumber(screen: Screen, testId: string, accept: (value: number) => boolean): Promise<number> {
	return pollUntil(() => readNumber(screen, testId), accept);
}

/** Reads "x,y" from a readout. */
async function readPair(screen: Screen, testId: string): Promise<{ x: number; y: number }> {
	const [x = Number.NaN, y = Number.NaN] = (await screen.getByTestId(testId).text()).split(",").map(Number);
	return { x, y };
}

test("pinch out zooms in", async ({ app, device, screen }) => {
	await openGestures(app, device, screen);
	const canvas = screen.getByTestId(ids.gestures.canvas);

	await canvas.pinch(2);

	expect(await pollNumber(screen, ids.gestures.scale, (v) => v > 1.4)).toBeGreaterThan(1.4);
	expect(await readNumber(screen, ids.gestures.pointers)).toBe(2);
});

test("pinch in zooms out", async ({ app, device, screen }) => {
	await openGestures(app, device, screen);
	const canvas = screen.getByTestId(ids.gestures.canvas);

	await canvas.pinch(0.5);

	expect(await pollNumber(screen, ids.gestures.scale, (v) => v < 0.75)).toBeLessThan(0.75);
});

test("rotate turns clockwise", async ({ app, device, screen }) => {
	await openGestures(app, device, screen);
	const canvas = screen.getByTestId(ids.gestures.canvas);

	await canvas.rotate(45);
	const clockwise = await pollNumber(screen, ids.gestures.rotation, (v) => v >= 30 && v <= 60);
	expect(clockwise).toBeGreaterThanOrEqual(30);
	expect(clockwise).toBeLessThanOrEqual(60);

	await screen.getByTestId(ids.gestures.reset).tap();
	await expect(screen.getByTestId(ids.gestures.rotation)).toHaveText("0");

	await canvas.rotate(-45);
	const counter = await pollNumber(screen, ids.gestures.rotation, (v) => v <= -30 && v >= -60);
	expect(counter).toBeLessThanOrEqual(-30);
	expect(counter).toBeGreaterThanOrEqual(-60);
});

test("two-finger pan moves the canvas square", async ({ app, device, screen }) => {
	await openGestures(app, device, screen);
	const box = await screen.getByTestId(ids.gestures.canvas).boundingBox();
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const half = (0.3 * box.width) / 2;
	const gap = box.height * 0.1;

	await screen.gesture.path({
		paths: [
			[
				{ x: cx - half, y: cy - gap },
				{ x: cx + half, y: cy - gap },
			],
			[
				{ x: cx - half, y: cy + gap },
				{ x: cx + half, y: cy + gap },
			],
		],
	});

	const panX = await pollNumber(screen, ids.gestures.panX, (v) => v >= 0.2 && v <= 0.4);
	expect(panX).toBeGreaterThanOrEqual(0.2);
	expect(panX).toBeLessThanOrEqual(0.4);
	expect(Math.abs(await readNumber(screen, ids.gestures.panY))).toBeLessThan(0.1);
	const scale = await readNumber(screen, ids.gestures.scale);
	expect(scale).toBeGreaterThanOrEqual(0.9);
	expect(scale).toBeLessThanOrEqual(1.1);
});

test("one-finger L path on the trace pad", async ({ app, device, screen }) => {
	await openGestures(app, device, screen);
	const pad = await screen.getByTestId(ids.gestures.trace).boundingBox();
	const at = (fx: number, fy: number) => ({ x: pad.x + fx * pad.width, y: pad.y + fy * pad.height });

	await screen.gesture.path({ paths: [[at(0.2, 0.2), at(0.8, 0.2), at(0.8, 0.8)]] });

	/** The readout is length / pad width: 0.6 of the width across, then 0.6 of the height down. */
	const expectedLength = 0.6 + (0.6 * pad.height) / pad.width;
	const length = await pollNumber(screen, ids.gestures.traceLength, (v) => v > 0.5 * expectedLength);
	expect(length).toBeGreaterThan(expectedLength * 0.85);
	expect(length).toBeLessThan(expectedLength * 1.15);

	const end = await readPair(screen, ids.gestures.traceEnd);
	expect(Math.abs(end.x - 0.8)).toBeLessThan(0.1);
	expect(Math.abs(end.y - 0.8)).toBeLessThan(0.1);
});
