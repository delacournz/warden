import { describe, expect, test } from "bun:test";
import { Command } from "@commander-js/extra-typings";
import { isEmptySelector, type LeaseSelector, selectorFrom, withSelectOptions } from "./lease-select";

function parse(argv: string[]): LeaseSelector {
	let selector: LeaseSelector | undefined;
	withSelectOptions(new Command("x").exitOverride().argument("[leaseIds...]"))
		.action((ids, opts) => {
			selector = selectorFrom(ids, opts);
		})
		.parse(argv, { from: "user" });
	if (!selector) throw new Error("action not run");
	return selector;
}

describe("lease selection options", () => {
	test("ids, repeatable --udid, --mine, --session", () => {
		expect(parse(["l_1", "l_2", "--udid", "U1", "--udid", "U2", "--mine", "--session", "s"])).toEqual({
			ids: ["l_1", "l_2"],
			udids: ["U1", "U2"],
			mine: true,
			session: "s",
		});
	});

	test("nothing given → empty selector", () => {
		const selector = parse([]);
		expect(selector).toEqual({ ids: [], udids: [], mine: false });
		expect(isEmptySelector(selector)).toBe(true);
	});
});
