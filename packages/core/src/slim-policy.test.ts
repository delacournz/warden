import { describe, expect, test } from "bun:test";
import { DEFAULT_SLIM_PROFILE, type SlimProfile } from "./sims/slim.profile";
import { resolveSlim } from "./slim-policy";

const ok = (data: SlimProfile | false) => ({ success: true as const, data });

describe("resolveSlim", () => {
	test("default is the default profile", () => {
		expect(resolveSlim({ env: {} })).toEqual(ok(DEFAULT_SLIM_PROFILE));
	});

	test("WARDEN_SLIM 0/false/off disables, other values do not", () => {
		for (const v of ["0", "false", "FALSE", "off"]) expect(resolveSlim({ env: { WARDEN_SLIM: v } })).toEqual(ok(false));
		expect(resolveSlim({ env: { WARDEN_SLIM: "1" } })).toEqual(ok(DEFAULT_SLIM_PROFILE));
	});

	test("top-level config beats env", () => {
		expect(resolveSlim({ topLevel: true, env: { WARDEN_SLIM: "0" } })).toEqual(ok(DEFAULT_SLIM_PROFILE));
		expect(resolveSlim({ topLevel: false, env: {} })).toEqual(ok(false));
	});

	test("suite config beats top-level", () => {
		expect(resolveSlim({ config: false, topLevel: true, env: {} })).toEqual(ok(false));
		expect(resolveSlim({ config: { except: ["store"] }, topLevel: false, env: {} })).toEqual(
			ok({ except: ["store"], keep: [] })
		);
	});

	test("--no-slim beats everything", () => {
		expect(resolveSlim({ flag: false, config: true, topLevel: true, env: {} })).toEqual(ok(false));
	});

	test("--slim beats config false and env off, and keeps a chosen profile", () => {
		expect(resolveSlim({ flag: true, config: false, env: { WARDEN_SLIM: "0" } })).toEqual(ok(DEFAULT_SLIM_PROFILE));
		expect(resolveSlim({ flag: true, config: { except: ["store"] }, env: {} })).toEqual(
			ok({ except: ["store"], keep: [] })
		);
	});

	test("an object profile is validated", () => {
		const bad = resolveSlim({ config: { except: ["nope"] }, env: {} });
		expect(bad.success).toBe(false);
		if (!bad.success) expect(bad.error).toContain("nope");
	});
});
