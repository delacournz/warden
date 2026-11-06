import { describe, expect, test } from "bun:test";
import { el, snapshotOf } from "../driver/driver.testing";
import { EMAIL_ERROR_FRAME, EMAIL_ERROR_TEXT, measuredLossySnapshot } from "./degraded.testing";
import { indexSnapshot } from "./nodes";
import type { ReactMatch } from "./react-locator";
import { mergeReactMatches, nodeOfReactMatch } from "./react-merge";

function match(frame: ReactMatch["frame"], extra: Partial<ReactMatch> = {}): ReactMatch {
	return {
		frame,
		tapPoint: { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
		source: "react",
		testId: "sign-in-email-error",
		name: "Text",
		...extra,
	};
}

describe("nodeOfReactMatch", () => {
	test("pairs the component with the accessibility node of the same rect", () => {
		const index = indexSnapshot(measuredLossySnapshot());
		const entry = nodeOfReactMatch(match(EMAIL_ERROR_FRAME, { text: EMAIL_ERROR_TEXT }), index);
		expect(entry?.element.label).toBe(EMAIL_ERROR_TEXT);
	});

	test("tolerates sub-point rounding between React's measure and the AX frame", () => {
		const index = indexSnapshot(measuredLossySnapshot());
		const frame = { x: 20.33, y: 257.67, width: 361.67, height: 20.33 };
		expect(nodeOfReactMatch(match(frame), index)?.element.label).toBe(EMAIL_ERROR_TEXT);
	});

	test("no node with that rect: undefined", () => {
		const index = indexSnapshot(measuredLossySnapshot());
		expect(nodeOfReactMatch(match({ x: 20, y: 182, width: 362, height: 82 }), index)).toBeUndefined();
	});

	test("never a node that carries another testID", () => {
		const index = indexSnapshot(snapshotOf([el("text", { id: "other", label: "x", frame: EMAIL_ERROR_FRAME })]));
		expect(nodeOfReactMatch(match(EMAIL_ERROR_FRAME), index)).toBeUndefined();
	});

	test("never pairs an area-less rect", () => {
		const zero = { x: 0, y: 0, width: 0, height: 0 };
		const index = indexSnapshot(snapshotOf([el("text", { label: "x", frame: zero })]));
		expect(nodeOfReactMatch(match(zero), index)).toBeUndefined();
	});

	test("several nodes share the rect: the one whose text is the component's, else the deepest", () => {
		const outer = el("other", {
			frame: EMAIL_ERROR_FRAME,
			children: [
				el("text", { label: "Other words", frame: EMAIL_ERROR_FRAME }),
				el("text", { label: EMAIL_ERROR_TEXT, frame: EMAIL_ERROR_FRAME }),
			],
		});
		const index = indexSnapshot(snapshotOf([outer]));
		expect(nodeOfReactMatch(match(EMAIL_ERROR_FRAME, { text: EMAIL_ERROR_TEXT }), index)?.element.label).toBe(
			EMAIL_ERROR_TEXT
		);
		expect(nodeOfReactMatch(match(EMAIL_ERROR_FRAME), index)?.depth).toBe(1);
	});
});

describe("mergeReactMatches", () => {
	test("every match paired: the nodes", () => {
		const index = indexSnapshot(measuredLossySnapshot());
		expect(mergeReactMatches([match(EMAIL_ERROR_FRAME)], index)?.map((entry) => entry.element.label)).toEqual([
			EMAIL_ERROR_TEXT,
		]);
	});

	test("one unpaired match: undefined (the React tree answers alone)", () => {
		const index = indexSnapshot(measuredLossySnapshot());
		const merged = mergeReactMatches([match(EMAIL_ERROR_FRAME), match({ x: 1, y: 1, width: 5, height: 5 })], index);
		expect(merged).toBeUndefined();
	});

	test("two matches on one node: undefined, never the same node twice", () => {
		const index = indexSnapshot(measuredLossySnapshot());
		expect(mergeReactMatches([match(EMAIL_ERROR_FRAME), match(EMAIL_ERROR_FRAME)], index)).toBeUndefined();
	});
});
