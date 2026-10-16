import { Option } from "@commander-js/extra-typings";
import type { InstallMode } from "@delacour/warden-core/builds/app-option.schema";
import { err, ok, type Result } from "@delacour/warden-types/result";

export const INSTALL_MODES = ["clean", "reinstall"] as const satisfies readonly InstallMode[];

export const RESET_KEYCHAIN_HELP =
	"--install-mode: also reset the iOS simulator's keychain (not cleared by uninstall either)";

/** `--install-mode <clean|reinstall>`; `prefix` scopes the help text (`"--app: "`). */
export function installModeOption(prefix = "") {
	return new Option(
		"--install-mode <mode>",
		`${prefix}clean = fresh app data each run without reinstalling an unchanged build; reinstall = uninstall + install each run (default: install only when the build differs)`
	).choices(INSTALL_MODES);
}

/** `--clean`: hidden, deprecated alias of `--install-mode reinstall`. */
export function legacyCleanOption() {
	return new Option("--clean", "deprecated: --install-mode reinstall").hideHelp();
}

/** The `--install-mode` / `--reset-keychain` / `--clean` option values. */
export type InstallFlagValues = { installMode?: InstallMode; resetKeychain?: true; clean?: true };

/** `--install-mode` family → ensure options; `--clean` maps to `reinstall`, `--reset-keychain` needs a mode. */
export function parseInstallFlags(
	opts: InstallFlagValues
): Result<{ installMode?: InstallMode; resetKeychain?: true }> {
	if (opts.clean && opts.installMode !== undefined) {
		return err("--clean (deprecated) can't be combined with --install-mode");
	}
	const installMode = opts.installMode ?? (opts.clean ? "reinstall" : undefined);
	if (opts.resetKeychain && installMode === undefined) return err("--reset-keychain needs --install-mode");
	return ok({
		...(installMode !== undefined ? { installMode } : {}),
		...(opts.resetKeychain ? { resetKeychain: true as const } : {}),
	});
}
