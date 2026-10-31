import type { ClassifiedRunnerErrorCode, RunnerBuildError } from "./runner-build.types";

type Rule = { code: Exclude<ClassifiedRunnerErrorCode, "ios_team_ambiguous">; match: RegExp; hint: string };

/** `Unlock Chris's iPhone to Continue`: xcodebuild waits for the passcode and never says it is locked any other way. */
export const UNLOCK_LINE = /\bunlock\b.*\bto continue\b/i;

/** First match wins: the specific device states come before the generic signing ones. */
const RULES: readonly Rule[] = [
	{
		code: "device_locked",
		match: UNLOCK_LINE,
		hint: "Unlock the phone (and keep it awake while the runner starts), then run the command again.",
	},
	{
		code: "developer_mode_off",
		match: /developer mode (is )?(disabled|not enabled|is off|must be enabled)|enable developer mode/i,
		hint: "On the phone: Settings > Privacy & Security > Developer Mode > on, then restart it when asked.",
	},
	{
		code: "runner_untrusted",
		match:
			/profile has not been explicitly trusted|untrusted developer|has not been trusted|invalid code signature, inadequate entitlements/i,
		hint: "On the phone: Settings > General > VPN & Device Management > the Apple Development profile > Trust. Free teams must do this once per team.",
	},
	{
		code: "ui_automation_disabled",
		match: /ui automation (is )?(disabled|not enabled|turned off)|enable ui automation/i,
		hint: "On the phone: Settings > Developer > Enable UI Automation > on.",
	},
	{
		code: "ddi_unavailable",
		match: /developer disk image|ddi (is )?(not|un)available|could not be mounted|failed to mount/i,
		hint: "Connect the phone with a cable, keep it unlocked and wait for Xcode to prepare it (Xcode > Window > Devices and Simulators), then retry.",
	},
	{
		code: "device_busy",
		match:
			/device is busy|device (is )?busy|preparing .* for development|is not available because it is (preparing|connecting)/i,
		hint: "The phone is still preparing for development or is used by another Xcode session. Wait a minute, close Xcode's device window, and retry.",
	},
	{
		code: "bundle_id_taken",
		match:
			/failed registering bundle identifier|cannot be registered to your development team|bundle identifier .* (is not available|already)/i,
		hint: "Another team owns this bundle id. Set a unique one: `ios.runnerBundleId` in warden.config.ts (for example com.yourname.warden.runner).",
	},
	{
		code: "no_account",
		match:
			/no account for team|no accounts? with apple id|add a new account in accounts settings|no signing certificate|communication with apple failed/i,
		hint: "Sign in to your Apple ID: Xcode > Settings > Accounts > +, then check the team is listed there.",
	},
	{
		code: "no_team",
		match: /requires a development team|select a development team/i,
		hint: "Set the signing team: `WARDEN_IOS_TEAM_ID=<10-character team id>` or `ios.teamId` in warden.config.ts.",
	},
	{
		code: "unsupported_os",
		match:
			/deployment target|requires ios|ios \d+(\.\d+)* or (newer|later)|(does not|doesn't) support ios|ios \d+(\.\d+)* (is )?(not supported|unsupported)|unsupported ios/i,
		hint: "The runner needs iOS 17 or newer, and an Xcode that supports the phone's iOS version: update the phone or Xcode.",
	},
];

function firstMatchingLine(text: string, match: RegExp): string {
	const line = text.split("\n").find((l) => match.test(l)) ?? text;
	return line
		.trim()
		.replace(/^error:\s*/i, "")
		.slice(0, 300);
}

/** The known failure in xcodebuild's / devicectl's output, or undefined for one warden has no fix for. */
export function classifyRunnerOutput(text: string): RunnerBuildError | undefined {
	for (const rule of RULES) {
		if (rule.match.test(text)) {
			return { code: rule.code, message: firstMatchingLine(text, rule.match), hint: rule.hint };
		}
	}
	return undefined;
}

/** The last `lines` lines of the output: what `build_failed` shows when nothing classifies. */
export function outputTail(text: string, lines = 12): string {
	return text.trim().split("\n").slice(-lines).join("\n");
}
