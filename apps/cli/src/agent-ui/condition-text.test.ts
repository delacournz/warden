import { describe, expect, test } from "bun:test";
import type { ConditionRecord } from "@delacour/warden-core/conditions/conditions.types";
import { conditionsLine } from "./condition-text";

const rec = <R extends ConditionRecord>(r: Omit<R, "owned" | "setAt">): ConditionRecord =>
	({ ...r, owned: [], setAt: 1 }) as ConditionRecord;

describe("conditionsLine", () => {
	test("none set", () => {
		expect(conditionsLine([])).toBeUndefined();
	});
	test("setting areas read as short phrases", () => {
		const line = conditionsLine([
			rec({ area: "permission", value: { grants: [{ bundleId: "x", permission: "location", state: "denied" }] } }),
			rec({ area: "locale", value: { timezone: "Asia/Tokyo", locale: "fr-FR" } }),
			rec({ area: "a11y", value: { textSize: "accessibility-large", boldText: true } }),
			rec({ area: "battery", value: { level: 15, cosmetic: true } }),
		]);
		expect(line).toBe(
			"permission location=denied · locale Asia/Tokyo fr-FR · a11y text accessibility-large bold · battery 15% (status bar)"
		);
	});
});
