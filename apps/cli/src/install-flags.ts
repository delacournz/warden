import { Option } from "@commander-js/extra-typings";
import type { InstallMode } from "@delacour/warden-config/app-option.schema";
import { BUILD_KINDS } from "@delacour/warden-config/build-kinds";
import { type Result, resultFactory } from "@delacour/warden-types/result";

export const INSTALL_MODES = ["clean", "reinstall"] as const satisfies readonly InstallMode[];

export const RESET_KEYCHAIN_HELP =
	"--install-mode: also reset the iOS simulator's keychain (not cleared by uninstall either)";

/** The `--install-mode` / `--reset-keychain` / `--clean` option values. */
export type InstallFlagValues = { installMode?: InstallMode; resetKeychain?: true; clean?: true };

export class InstallFlags {
	/** `--install-mode <clean|reinstall>`; `prefix` scopes the help text (`"--app: "`). */
	installModeOption(prefix = "") {
		return new Option(
			"--install-mode <mode>",
			`${prefix}clean = fresh app data each run without reinstalling an unchanged build; reinstall = uninstall + install each run (default: install only when the build differs)`
		).choices(INSTALL_MODES);
	}

	/** `--clean`: hidden, deprecated alias of `--install-mode reinstall`. */
	legacyCleanOption() {
		return new Option("--clean", "deprecated: --install-mode reinstall").hideHelp();
	}

	/** `--install-mode` family → ensure options; `--clean` maps to `reinstall`, `--reset-keychain` needs a mode. */
	parseInstallFlags(opts: InstallFlagValues): Result<{ installMode?: InstallMode; resetKeychain?: true }> {
		if (opts.clean && opts.installMode !== undefined) {
			return resultFactory.err("--clean (deprecated) can't be combined with --install-mode");
		}
		const installMode = opts.installMode ?? (opts.clean ? "reinstall" : undefined);
		if (opts.resetKeychain && installMode === undefined)
			return resultFactory.err("--reset-keychain needs --install-mode");
		return resultFactory.ok({
			...(installMode !== undefined ? { installMode } : {}),
			...(opts.resetKeychain ? { resetKeychain: true as const } : {}),
		});
	}

	/** `--kind <dev|simulator|release>`; `prefix` scopes the help text (`"--app: "`). */
	kindOption(prefix = "") {
		return new Option(
			"--kind <kind>",
			`${prefix}install this build kind: dev (Debug, Metro), simulator (Release + this worktree's JS repacked in seconds), release (JS embedded at build)`
		).choices(BUILD_KINDS);
	}
}

export const installFlags = new InstallFlags();
