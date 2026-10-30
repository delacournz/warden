import { describe, expect, test } from "bun:test";
import {
	androidA11yResets,
	IOS_A11Y_DEFAULTS,
	iosDefaultsDeleteArgvs,
	iosDefaultsFields,
	iosDefaultsMissing,
	iosDefaultsWriteArgvs,
} from "./a11y-keys";

describe("ios accessibility defaults", () => {
	test("maps each setting to its com.apple.Accessibility key", () => {
		expect(IOS_A11Y_DEFAULTS).toEqual({
			reduceMotion: "ReduceMotionEnabled",
			boldText: "EnhancedTextLegibilityEnabled",
			reduceTransparency: "EnhancedBackgroundContrastEnabled",
			buttonShapes: "ButtonShapesEnabled",
			differentiateWithoutColor: "DifferentiateWithoutColor",
			onOffLabels: "IncreaseButtonLegibilityEnabled",
			screenReader: "VoiceOverTouchEnabled",
		});
	});
	test("one bare `defaults write` spawn per key, YES / NO", () => {
		expect(
			iosDefaultsWriteArgvs("U1", [
				["reduceMotion", true],
				["boldText", false],
			])
		).toEqual([
			[
				"xcrun",
				"simctl",
				"spawn",
				"U1",
				"defaults",
				"write",
				"com.apple.Accessibility",
				"ReduceMotionEnabled",
				"-bool",
				"YES",
			],
			[
				"xcrun",
				"simctl",
				"spawn",
				"U1",
				"defaults",
				"write",
				"com.apple.Accessibility",
				"EnhancedTextLegibilityEnabled",
				"-bool",
				"NO",
			],
		]);
	});
	test("delete argv per key; a missing key is recognised", () => {
		expect(iosDefaultsDeleteArgvs("U1", ["screenReader"])).toEqual([
			["xcrun", "simctl", "spawn", "U1", "defaults", "delete", "com.apple.Accessibility", "VoiceOverTouchEnabled"],
		]);
		expect(iosDefaultsMissing("The domain/default pair of (a, b) does not exist")).toBe(true);
		expect(iosDefaultsMissing("Domain (com.apple.Accessibility) not found.")).toBe(true);
		expect(iosDefaultsMissing("Could not write domain")).toBe(false);
	});
	test("iosDefaultsFields picks only the defaults-backed fields present in a record", () => {
		expect(
			iosDefaultsFields({ textSize: "large", boldText: false, screenReader: true, highContrastText: true })
		).toEqual(["boldText", "screenReader"]);
		expect(iosDefaultsFields({ contrast: "increased" })).toEqual([]);
	});
});

describe("android accessibility resets", () => {
	test("only the settings the record holds are reset", () => {
		expect(androidA11yResets({ fontScale: 2 })).toEqual([]);
		expect(androidA11yResets({ highContrastText: true, colorInversion: false, reduceMotion: true })).toEqual([
			["settings", "put", "secure", "high_text_contrast_enabled", "0"],
			["settings", "put", "secure", "accessibility_display_inversion_enabled", "0"],
			["settings", "put", "global", "transition_animation_scale", "1.0"],
		]);
	});
});
