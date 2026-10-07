import { describe, expect, test } from "bun:test";
import { appOptionSchema, appSwitches } from "./app-option.schema";

describe("appOptionSchema", () => {
	test("boolean or { clean, variant }, nothing else", () => {
		expect(appOptionSchema.safeParse(true).success).toBe(true);
		expect(appOptionSchema.safeParse({ clean: true }).success).toBe(true);
		expect(appOptionSchema.safeParse({}).success).toBe(true);
		expect(appOptionSchema.safeParse({ clean: "yes" }).success).toBe(false);
		expect(appOptionSchema.safeParse({ other: 1 }).success).toBe(false);
		expect(appOptionSchema.safeParse({ variant: "e2e" }).success).toBe(true);
		expect(appOptionSchema.safeParse({ variant: "" }).success).toBe(false);
	});

	test("appSwitches", () => {
		expect(appSwitches(undefined)).toEqual({ app: false, clean: false });
		expect(appSwitches(false)).toEqual({ app: false, clean: false });
		expect(appSwitches(true)).toEqual({ app: true, clean: false });
		expect(appSwitches({})).toEqual({ app: true, clean: false });
		expect(appSwitches({ clean: true })).toEqual({ app: true, clean: true });
		expect(appSwitches({ clean: false })).toEqual({ app: true, clean: false });
		expect(appSwitches({ variant: "e2e", clean: true })).toEqual({ app: true, clean: true, variant: "e2e" });
	});
});
