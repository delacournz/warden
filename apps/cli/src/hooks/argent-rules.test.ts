import { describe, expect, test } from "bun:test";
import { patchArgentRules, WARDEN_RULE_LINE } from "./argent-rules";

const RULE = `intro

<device_selection_rule>
Before booting, call \`list-devices\` first.

Decision order:

1. **Explicit user intent** - choose it.
2. **Prefer a running device.**
   </device_selection_rule>

<general_rules>
- stuff
</general_rules>
`;

describe("patchArgentRules", () => {
	test("inserts the warden step before step 1", () => {
		const result = patchArgentRules(RULE);
		expect(result.kind).toBe("patched");
		if (result.kind !== "patched") return;
		expect(result.text).toContain(`Decision order:\n\n${WARDEN_RULE_LINE}\n1. **Explicit user intent**`);
		expect(result.text.replace(`${WARDEN_RULE_LINE}\n`, "")).toBe(RULE);
		expect(WARDEN_RULE_LINE).toStartWith("0. **Claim via warden first**");
		expect(WARDEN_RULE_LINE).toContain("~5 min");
	});

	test("idempotent: already mentions warden → unchanged", () => {
		const once = patchArgentRules(RULE);
		if (once.kind !== "patched") throw new Error("expected patch");
		expect(patchArgentRules(once.text)).toEqual({ kind: "unchanged", reason: "already-patched" });
	});

	test("no decision order list → insert right after the opening tag", () => {
		const text = "<device_selection_rule>\nPick a device.\n</device_selection_rule>\n";
		const result = patchArgentRules(text);
		expect(result).toEqual({
			kind: "patched",
			text: `<device_selection_rule>\n${WARDEN_RULE_LINE}\nPick a device.\n</device_selection_rule>\n`,
		});
	});

	test("no device_selection_rule → unchanged", () => {
		expect(patchArgentRules("# rules\n")).toEqual({ kind: "unchanged", reason: "no-rule" });
	});
});
