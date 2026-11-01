import { describe, expect, test } from "bun:test";
import type { ReadFile } from "./js-inputs";
import { PREBUILT_RN_SALT, planPrebuiltRn } from "./prebuilt-rn";

const enc = new TextEncoder();

/** A fake project tree: path suffix → file text. */
function files(tree: Record<string, string>): ReadFile {
	return async (path) => {
		for (const [suffix, text] of Object.entries(tree)) if (path.endsWith(suffix)) return enc.encode(text);
		return undefined;
	};
}

const rn = (version: string) => ({ "node_modules/react-native/package.json": JSON.stringify({ version }) });
const base = { platform: "ios" as const, projectRoot: "/p", env: {}, readFile: files(rn("0.82.1")) };

describe("planPrebuiltRn", () => {
	test("RN 0.81-0.83 iOS: injects both vars and salts", async () => {
		for (const v of ["0.81.0", "0.82.1", "0.83.4"]) {
			const plan = await planPrebuiltRn({ ...base, readFile: files(rn(v)) });
			expect(plan.env).toEqual({ RCT_USE_PREBUILT_RNCORE: "1", RCT_USE_RN_DEP: "1" });
			expect(plan.salt).toBe(PREBUILT_RN_SALT);
		}
	});

	test("below 0.81 or unreadable → nothing", async () => {
		expect(await planPrebuiltRn({ ...base, readFile: files(rn("0.80.9")) })).toEqual({ env: {} });
		expect(await planPrebuiltRn({ ...base, readFile: files({}) })).toEqual({ env: {} });
		expect(await planPrebuiltRn({ ...base, readFile: files(rn("nonsense")) })).toEqual({ env: {} });
	});

	test("0.84+ is already the default → no-op, no salt", async () => {
		expect(await planPrebuiltRn({ ...base, readFile: files(rn("0.86.3")) })).toEqual({ env: {} });
	});

	test("android → nothing", async () => {
		expect(await planPrebuiltRn({ ...base, platform: "android" })).toEqual({ env: {} });
	});

	test("opt-outs: config false, WARDEN_PREBUILT_RN=0", async () => {
		expect(await planPrebuiltRn({ ...base, optOut: true })).toEqual({ env: {} });
		expect(await planPrebuiltRn({ ...base, env: { WARDEN_PREBUILT_RN: "0" } })).toEqual({ env: {} });
	});

	test("user env wins and the salt follows the effective state", async () => {
		const off = await planPrebuiltRn({ ...base, env: { RCT_USE_PREBUILT_RNCORE: "0" } });
		expect(off.env).toEqual({ RCT_USE_RN_DEP: "1" });
		expect(off.salt).toBeUndefined();
		const on = await planPrebuiltRn({ ...base, env: { RCT_USE_PREBUILT_RNCORE: "1", RCT_USE_RN_DEP: "1" } });
		expect(on.env).toEqual({});
		expect(on.salt).toBe(PREBUILT_RN_SALT);
	});

	test("respects ios.buildReactNativeFromSource (Podfile.properties.json, app.json plugin)", async () => {
		const podfile = files({
			...rn("0.82.1"),
			"ios/Podfile.properties.json": '{"ios.buildReactNativeFromSource":"true"}',
		});
		expect(await planPrebuiltRn({ ...base, readFile: podfile })).toEqual({ env: {} });
		const appJson = files({
			...rn("0.82.1"),
			"app.json": JSON.stringify({
				expo: { plugins: ["expo-router", ["expo-build-properties", { ios: { buildReactNativeFromSource: true } }]] },
			}),
		});
		expect(await planPrebuiltRn({ ...base, readFile: appJson })).toEqual({ env: {} });
	});
});
