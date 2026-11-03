import { describe, expect, test } from "bun:test";
import { classifyRunnerOutput, outputTail, UNLOCK_LINE } from "./classify";
import type { ClassifiedRunnerErrorCode } from "./runner-build.types";

/** One xcodebuild / devicectl line per code, as the tools print them. */
const FIXTURES: ReadonlyArray<readonly [Exclude<ClassifiedRunnerErrorCode, "ios_team_ambiguous">, string]> = [
	[
		"no_account",
		`error: No Account for Team "LN69P7N673". Add a new account in Accounts settings or verify that your accounts have valid credentials. (in target 'WardenRunnerHost' from project 'WardenRunner')`,
	],
	[
		"no_team",
		`error: Signing for "WardenRunnerHost" requires a development team. Select a development team in the Signing & Capabilities editor. (in target 'WardenRunnerHost' from project 'WardenRunner')`,
	],
	[
		"bundle_id_taken",
		`error: Failed Registering Bundle Identifier: The app identifier "nz.co.delacour.warden.runner.ln69p7n673" cannot be registered to your development team because it is not available. Change your bundle identifier to a unique string to try again.`,
	],
	["device_locked", "Unlock Chris's iPhone to Continue"],
	[
		"developer_mode_off",
		"error: Developer Mode disabled. To use Chris's iPhone for development, enable Developer Mode in Settings -> Privacy & Security.",
	],
	[
		"runner_untrusted",
		"Unable to launch nz.co.delacour.warden.runner.ln69p7n673 because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user.",
	],
	["ui_automation_disabled", "Failed to start: UI Automation is not enabled on Chris's iPhone."],
	["device_busy", "The device is busy (Preparing Chris's iPhone for development)."],
	["ddi_unavailable", "The Developer Disk Image could not be mounted on Chris's iPhone."],
	[
		"unsupported_os",
		"error: The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 17.0, but the device runs iOS 16.7.",
	],
];

describe("classifyRunnerOutput", () => {
	for (const [code, line] of FIXTURES) {
		test(`${code}`, () => {
			const noisy = `CompileSwift normal arm64 Foo.swift\n${line}\n** TEST BUILD FAILED **`;
			const got = classifyRunnerOutput(noisy);
			expect(got?.code).toBe(code);
			expect(got?.hint.length).toBeGreaterThan(10);
		});
	}

	test("the message is the matching line without the `error:` prefix", () => {
		const got = classifyRunnerOutput("a\nUnlock Chris's iPhone to Continue\nb");
		expect(got?.message).toBe("Unlock Chris's iPhone to Continue");
	});

	test("a lock wins over the signing errors printed around it", () => {
		const text = `${FIXTURES[1]?.[1]}\nUnlock Chris's iPhone to Continue`;
		expect(classifyRunnerOutput(text)?.code).toBe("device_locked");
	});

	test("an unknown failure is not classified", () => {
		expect(classifyRunnerOutput("ld: symbol(s) not found for architecture arm64")).toBeUndefined();
		expect(classifyRunnerOutput("")).toBeUndefined();
	});

	test("UNLOCK_LINE matches the lock line only", () => {
		expect(UNLOCK_LINE.test("Unlock Chris's iPhone to Continue")).toBe(true);
		expect(UNLOCK_LINE.test("Compiling Unlock.swift")).toBe(false);
	});
});

describe("outputTail", () => {
	test("keeps the last lines", () => {
		const text = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
		expect(outputTail(text, 3)).toBe("l27\nl28\nl29");
	});
});
