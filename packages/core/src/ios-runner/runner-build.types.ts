import type { AsyncResult } from "@delacour/warden-types/result";
import type { BuildLockDeps } from "../builds/lock";
import type { Exec } from "../exec";

/** Codes `classify.ts` and `signing.ts` give a failure that has a known fix; every one comes with a `hint`. */
export const CLASSIFIED_RUNNER_ERRORS = [
	"no_account",
	"no_team",
	"ios_team_ambiguous",
	"bundle_id_taken",
	"device_locked",
	"developer_mode_off",
	"runner_untrusted",
	"ui_automation_disabled",
	"device_busy",
	"ddi_unavailable",
	"unsupported_os",
] as const;

export type ClassifiedRunnerErrorCode = (typeof CLASSIFIED_RUNNER_ERRORS)[number];

/** A team the keychain holds an `Apple Development` identity for. */
export type SigningTeam = { teamId: string; identities: string[] };

type RunnerErrorBase = { message: string; hint: string };

/**
 * Why the on-device runner cannot be built / signed / started. `hint` is the one thing to do about it.
 * `ios_team_ambiguous` carries the teams to pick from; `build_failed` is anything unclassified (with the
 * tail of the output).
 */
export type RunnerBuildError =
	| (RunnerErrorBase & { code: Exclude<ClassifiedRunnerErrorCode, "ios_team_ambiguous"> })
	| (RunnerErrorBase & { code: "ios_team_ambiguous"; teams: SigningTeam[] })
	| (RunnerErrorBase & { code: "build_failed"; output: string });

export type RunnerBuildErrorCode = RunnerBuildError["code"];

/** Where the signing team came from. */
export type TeamSource = "input" | "env" | "config" | "keychain";

/** The runner sources as a map of path (relative to the staged root, `/`-separated) to text. */
export type RunnerSourceFiles = Readonly<Record<string, string>>;

export type EnsureRunnerBuildInput = {
	/** the phone the runner must be signed for (`-destination id=`; registers it in the provisioning profile) */
	udid: string;
	/** signing team; default: `WARDEN_IOS_TEAM_ID`, then `ios.teamId`, then the keychain */
	team?: string | undefined;
	/** `ios.teamId` of `warden.config.ts` */
	configTeamId?: string | undefined;
	/** `ios.runnerBundleId` of `warden.config.ts` */
	configBundleId?: string | undefined;
	env: Record<string, string | undefined>;
	/** `$WARDEN_HOME` (default: from `env`) */
	home?: string | undefined;
	exec: Exec;
	/** warden's own version (part of the staged-source directory name) */
	version: string;
	/** the embedded runner sources (blob in a compiled binary, the checkout when run from source) */
	loadSources: () => AsyncResult<RunnerSourceFiles>;
	/** serialises builds of one (team, Xcode, sources): the build lease */
	lock: BuildLockDeps;
	now?: () => number;
	/** progress lines (xcodebuild's own output is not forwarded) */
	log?: (line: string) => void;
	/** `xcodebuild` is stopped after this long (default 15 min) */
	timeoutMs?: number;
	/** after xcodebuild asks to unlock the phone, wait this long before giving up with `device_locked` (default 45 s) */
	lockGraceMs?: number;
};

/** A runner build ready for `xcodebuild test-without-building -xctestrun <xctestrun>`. */
export type RunnerBuild = {
	/** the `.xctestrun` inside `derivedData` */
	xctestrun: string;
	derivedData: string;
	/** the host app's bundle id (the UI-test bundle is `<id>.uitests`, its runner app `<id>.uitests.xctrunner`) */
	bundleId: string;
	team: string;
	teamSource: TeamSource;
	/** false: built just now */
	cached: boolean;
	/** why it was (re)built when `cached` is false */
	rebuiltBecause?: "none" | "new_udid" | "profile_expiring" | "bundle_id" | "missing";
};
