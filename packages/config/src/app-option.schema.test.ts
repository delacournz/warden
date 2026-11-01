import { describe, expect, test } from "bun:test";
import { appOptionSchema, appSwitches } from "./app-option.schema";

describe("appOptionSchema", () => {
	test("boolean or { installMode, resetKeychain, variant }, nothing else", () => {
		expect(appOptionSchema.safeParse(true).success).toBe(true);
		expect(appOptionSchema.safeParse({}).success).toBe(true);
		expect(appOptionSchema.safeParse({ installMode: "clean" }).success).toBe(true);
		expect(appOptionSchema.safeParse({ installMode: "reinstall" }).success).toBe(true);
		expect(appOptionSchema.safeParse({ installMode: "wipe" }).success).toBe(false);
		expect(appOptionSchema.safeParse({ other: 1 }).success).toBe(false);
		expect(appOptionSchema.safeParse({ variant: "e2e" }).success).toBe(true);
		expect(appOptionSchema.safeParse({ variant: "" }).success).toBe(false);
	});

	test("resetKeychain needs installMode", () => {
		expect(appOptionSchema.safeParse({ installMode: "clean", resetKeychain: true }).success).toBe(true);
		expect(appOptionSchema.safeParse({ installMode: "reinstall", resetKeychain: true }).success).toBe(true);
		expect(appOptionSchema.safeParse({ resetKeychain: false }).success).toBe(true);
		const bare = appOptionSchema.safeParse({ resetKeychain: true });
		expect(bare.success).toBe(false);
		expect(JSON.stringify(bare.error?.issues)).toContain("resetKeychain needs installMode");
		expect(appOptionSchema.safeParse({ clean: true, resetKeychain: true }).success).toBe(true);
	});

	test("legacy clean: true is accepted; with installMode it is an error", () => {
		expect(appOptionSchema.safeParse({ clean: true }).success).toBe(true);
		expect(appOptionSchema.safeParse({ clean: "yes" }).success).toBe(false);
		expect(appOptionSchema.safeParse({ clean: true, installMode: "clean" }).success).toBe(false);
	});

	test("kind is dev | simulator | release, and excludes variant", () => {
		for (const kind of ["dev", "simulator", "release"]) {
			expect(appOptionSchema.safeParse({ kind }).success).toBe(true);
		}
		expect(appOptionSchema.safeParse({ kind: "debug" }).success).toBe(false);
		const both = appOptionSchema.safeParse({ kind: "simulator", variant: "e2e" });
		expect(both.success).toBe(false);
		expect(JSON.stringify(both.error?.issues)).toContain("kind or variant");
		expect(appSwitches({ kind: "release", installMode: "clean" })).toEqual({
			app: true,
			installMode: "clean",
			kind: "release",
		});
		expect(appSwitches(true)).not.toHaveProperty("kind");
	});

	test("appSwitches", () => {
		expect(appSwitches(undefined)).toEqual({ app: false });
		expect(appSwitches(false)).toEqual({ app: false });
		expect(appSwitches(true)).toEqual({ app: true });
		expect(appSwitches({})).toEqual({ app: true });
		expect(appSwitches({ installMode: "clean" })).toEqual({ app: true, installMode: "clean" });
		expect(appSwitches({ installMode: "reinstall", resetKeychain: true })).toEqual({
			app: true,
			installMode: "reinstall",
			resetKeychain: true,
		});
		expect(appSwitches({ installMode: "clean", resetKeychain: false })).toEqual({ app: true, installMode: "clean" });
		expect(appSwitches({ clean: true })).toEqual({ app: true, installMode: "reinstall" });
		expect(appSwitches({ clean: false })).toEqual({ app: true });
		expect(appSwitches({ variant: "e2e", installMode: "reinstall" })).toEqual({
			app: true,
			installMode: "reinstall",
			variant: "e2e",
		});
	});
});
