import { describe, expect, test } from "bun:test";
import { el, snap } from "./element.testing";
import { indexSnapshot } from "./nodes";
import {
	formatSelector,
	matchesSelector,
	type ParsedSelector,
	parseSelector,
	pickMostSpecific,
	selectorToQuery,
} from "./selector";

function parsed(input: string): ParsedSelector {
	const result = parseSelector(input);
	if (!result.success) throw new Error(`parse failed: ${result.error}`);
	return result.data;
}

describe("parseSelector", () => {
	test("bare words", () => {
		expect(parsed("id=sign-in-submit role=button")).toEqual({
			id: { kind: "text", value: "sign-in-submit" },
			role: { kind: "text", value: "button" },
		});
	});

	test("quoted values keep spaces and escapes", () => {
		expect(parsed('label="Sign in" text="say \\"hi\\""')).toEqual({
			label: { kind: "text", value: "Sign in" },
			text: { kind: "text", value: 'say "hi"' },
		});
	});

	test("regex values with flags", () => {
		expect(parsed("text=/^Total: \\d+$/i")).toEqual({ text: { kind: "regex", source: "^Total: \\d+$", flags: "i" } });
		expect(parsed("id=/a\\/b/")).toEqual({ id: { kind: "regex", source: "a\\/b", flags: "" } });
	});

	test("editable and nth", () => {
		expect(parsed("role=textbox editable=true nth=2")).toEqual({
			role: { kind: "text", value: "textbox" },
			editable: true,
			nth: 2,
		});
		expect(parsed("editable=false").editable).toBe(false);
	});

	test("extra whitespace is fine", () => {
		expect(parsed("  id=a   role=button  ")).toEqual({
			id: { kind: "text", value: "a" },
			role: { kind: "text", value: "button" },
		});
	});

	const rejections: [string, string, RegExp][] = [
		["empty", "", /empty/i],
		["blank", "   ", /empty/i],
		["bare word", "button", /key=value/],
		["unknown key", "color=red", /unknown key "color"/],
		["missing value", "id= role=button", /missing value/i],
		["dangling key", "id=", /missing value/i],
		["unterminated quote", 'label="Sign in', /unterminated/i],
		["bad escape", 'label="a\\qb"', /escape/i],
		["junk after quote", 'label="a"b', /after/i],
		["unterminated regex", "text=/abc", /unterminated/i],
		["empty regex", "text=//", /empty regex/i],
		["bad regex", "text=/(/", /invalid regex/i],
		["bad regex flag", "text=/a/z", /invalid regex/i],
		["duplicate key", "id=a id=b", /duplicate/i],
		["editable not boolean", "editable=maybe", /true or false/],
		["nth not integer", "nth=1.5", /non-negative integer/],
		["nth negative", "nth=-1", /non-negative integer/],
		["nth word", "nth=first", /non-negative integer/],
	];
	for (const [title, input, message] of rejections) {
		test(`rejects ${title}`, () => {
			const result = parseSelector(input);
			expect(result.success).toBe(false);
			if (!result.success) expect(result.error).toMatch(message);
		});
	}
});

describe("formatSelector", () => {
	test("canonical order and quoting", () => {
		expect(formatSelector({ role: { kind: "text", value: "button" }, id: { kind: "text", value: "a b" } })).toBe(
			'id="a b" role=button'
		);
		expect(formatSelector({ nth: 1, editable: true, text: { kind: "regex", source: "x+", flags: "i" } })).toBe(
			"text=/x+/i editable=true nth=1"
		);
	});

	test("values that cannot be bare are quoted", () => {
		expect(formatSelector({ text: { kind: "text", value: "" } })).toBe('text=""');
		expect(formatSelector({ text: { kind: "text", value: "/path" } })).toBe('text="/path"');
		expect(formatSelector({ text: { kind: "text", value: '"q"' } })).toBe('text="\\"q\\""');
	});

	const roundTrips = [
		"id=sign-in-submit",
		'label="Sign in" role=button',
		"text=/^Total: \\d+$/i",
		"id=/a\\/b/ nth=3",
		"role=textbox editable=true",
		"editable=false",
		'text="line\\nbreak"',
		'text=""',
		'value="a \\"quoted\\" b"',
	];
	for (const input of roundTrips) {
		test(`round-trips ${input}`, () => {
			const first = parsed(input);
			const text = formatSelector(first);
			expect(parsed(text)).toEqual(first);
			expect(formatSelector(parsed(text))).toBe(text);
		});
	}

	test("canonical text equals the (already canonical) input", () => {
		expect(formatSelector(parsed('id=a label="b c" text=/d/ role=button value=e editable=true nth=0'))).toBe(
			'id=a label="b c" text=/d/ role=button value=e editable=true nth=0'
		);
	});
});

describe("selectorToQuery", () => {
	test("without nth is one selector query", () => {
		expect(selectorToQuery(parsed("id=a"))).toEqual({
			kind: "query",
			query: { kind: "selector", selector: { id: { kind: "text", value: "a" } } },
		});
	});

	test("nth wraps in an index expression and leaves the selector clean", () => {
		expect(selectorToQuery(parsed("role=button nth=2"))).toEqual({
			kind: "index",
			index: 2,
			source: { kind: "query", query: { kind: "selector", selector: { role: { kind: "text", value: "button" } } } },
		});
	});
});

describe("matchesSelector", () => {
	const index = indexSnapshot(
		snap([
			el("button", { identifier: "sign-in-submit", label: "Sign in", value: "go" }),
			el("textfield", { identifier: "email", label: "Email address", value: "me@x.co", placeholder: "you@x.co" }),
			el("other", { value: "checkbox, unchecked", label: "Agree" }),
			el("text", { label: "Sign in now" }),
		])
	);
	const [button, field, agree, text] = index.entries;
	const match = (input: string) => index.entries.filter((entry) => matchesSelector(entry, parsed(input)));

	test("id is exact and case-sensitive", () => {
		expect(match("id=sign-in-submit")).toEqual([button]);
		expect(match("id=sign-in")).toEqual([]);
		expect(match("id=/^sign/")).toEqual([button]);
	});

	test("label, text and value are case-insensitive substrings", () => {
		expect(match("label=sign")).toEqual([button, text]);
		expect(match('label="EMAIL ADDRESS"')).toEqual([field]);
		expect(match("text=now")).toEqual([text]);
		expect(match("value=ME@X")).toEqual([field]);
	});

	test("text also reads the value", () => {
		expect(match("text=go")).toEqual([button]);
	});

	test("regex terms are applied as written", () => {
		expect(match("label=/^Sign in$/")).toEqual([button]);
		expect(match("label=/^sign in$/")).toEqual([]);
	});

	test("role accepts query roles, driver roles and raw types", () => {
		expect(match("role=textbox")).toEqual([field]);
		expect(match("role=textfield")).toEqual([field]);
		expect(match("role=checkbox")).toEqual([agree]);
		expect(match("role=StaticText")).toEqual([]);
		expect(match("role=BUTTON")).toEqual([button]);
	});

	test("editable", () => {
		expect(match("editable=true")).toEqual([field]);
		expect(match("editable=false")).toEqual([button, agree, text]);
	});

	test("terms are anded", () => {
		expect(match("label=sign role=button")).toEqual([button]);
	});
});

describe("pickMostSpecific", () => {
	test("exact beats substring beats smaller frame beats reading order; visible preferred", () => {
		const index = indexSnapshot(
			snap([
				el("button", { label: "Save changes", frame: { x: 0, y: 0, width: 50, height: 10 } }),
				el("button", { label: "Save", frame: { x: 0, y: 20, width: 200, height: 40 } }),
				el("button", { label: "Save as", frame: { x: 0, y: 70, width: 20, height: 10 } }),
				el("button", { label: "Save", hidden: true, frame: { x: 0, y: 90, width: 5, height: 5 } }),
			])
		);
		const sel = parsed("label=save");
		const matches = index.entries.filter((entry) => matchesSelector(entry, sel));
		expect(pickMostSpecific(matches, sel)?.element.label).toBe("Save");
		expect(pickMostSpecific(matches, sel)?.element.hidden).toBeUndefined();
		const substringOnly = parsed("label=sav");
		expect(pickMostSpecific(matches, substringOnly)?.element.label).toBe("Save as");
	});

	test("ties fall to reading order; empty is undefined", () => {
		const index = indexSnapshot(snap([el("button", { label: "A" }), el("button", { label: "A" })]));
		const sel = parsed("label=A");
		expect(pickMostSpecific(index.entries, sel)).toBe(index.entries[0]);
		expect(pickMostSpecific([], sel)).toBeUndefined();
	});
});
