import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";
import type { EnsureOptions } from "@delacour/warden-builds/prepare";
import type { InstallMode } from "@delacour/warden-config/app-option.schema";
import type { BuildKind } from "@delacour/warden-config/build-kinds";
import type { ClaimOutcome } from "@delacour/warden-leasing/claim";
import { type LeaseArgs, sessionRules } from "@delacour/warden-leasing/session";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { appPhaseHelpers } from "./app-phase";
import type { CommandContext } from "./context";
import { installFlags, RESET_KEYCHAIN_HELP } from "./install-flags";
import type { Spinner } from "./ui";

/** `--app` family option values shared by `run` and `batch`. */
export type AppFlagValues = {
	app?: true;
	/** `--install-mode` */
	installMode?: InstallMode;
	/** `--reset-keychain` */
	resetKeychain?: true;
	/** `--clean`: deprecated alias of `--install-mode reinstall` */
	clean?: true;
	project?: string;
	bundleId?: string;
	/** `--variant <name>`: a `projects[].variants` build */
	variant?: string;
	/** `--kind <kind>`: a build kind (`simulator` = repacked) instead of the project's kind-less build */
	kind?: BuildKind;
	/** not a flag: the env `warden e2e` bundles a `simulator` / `release` build's JS with (the suite's `metro.env`) */
	bundleEnv?: Record<string, string>;
	/** false = `--no-eas` */
	eas: boolean;
	/** false = `--no-build` */
	build: boolean;
};

export class LeaseOptions {
	/** The commander side of `warden run` / `warden batch` lease sessions (the engine is `@delacour/warden-leasing/session`). */

	/** `[flags…, "--", cmd…]` → flags + command (everything after the first `--`). */
	splitCommand(argv: readonly string[]): { flags: string[]; cmd: string[] } {
		const i = argv.indexOf("--");
		return i === -1 ? { flags: [...argv], cmd: [] } : { flags: argv.slice(0, i), cmd: argv.slice(i + 1) };
	}

	/**
	 * The child command is everything after the first `--` of the raw argv (commander drops the `--`
	 * itself); the operands before it are the optional platform.
	 */
	splitOperands(
		argv: readonly string[],
		operands: readonly string[],
		name = "run"
	): Result<{ platformArg?: string; cmd: string[] }> {
		const { cmd } = this.splitCommand(argv);
		if (cmd.length === 0) return resultFactory.err(`missing command after -- (warden ${name} ios -- <cmd…>)`);
		const before = operands.slice(0, Math.max(0, operands.length - cmd.length));
		if (before.length > 1) return resultFactory.err(`unexpected arguments before --: ${before.slice(1).join(" ")}`);
		const [platformArg] = before;
		return resultFactory.ok(platformArg === undefined ? { cmd } : { platformArg, cmd });
	}

	/** `--port` / `--app` family options shared by `run` and `batch`. */
	withLeaseOptions<Args extends unknown[], Opts extends OptionValues, Globals extends OptionValues>(
		cmd: Commander<Args, Opts, Globals>
	) {
		return cmd
			.option(
				"--port <from:span>",
				"lease a port from FROM..FROM+SPAN-1 (inclusive) for the child (WARDEN_PORT_<i>); repeatable",
				(value: string, previous: string[]) => [...previous, value],
				[] as string[]
			)
			.option("--app", "install the project's app (fingerprint → cache → EAS → build) on each device first")
			.addOption(installFlags.installModeOption("--app: "))
			.option("--reset-keychain", RESET_KEYCHAIN_HELP)
			.addOption(installFlags.legacyCleanOption())
			.option("--project <dir>", "--app: project directory (default: cwd)")
			.option("--bundle-id <id>", "--app: override the bundle id / package")
			.option("--variant <name>", "--app: install this projects[].variants build (dev, e2e…)")
			.addOption(installFlags.kindOption("--app: "))
			.option("--no-eas", "--app: don't download EAS builds")
			.option("--no-build", "--app: don't build locally on a cache miss");
	}

	private kindWithVariant(opts: Pick<AppFlagValues, "kind" | "variant">): boolean {
		return opts.kind !== undefined && opts.variant !== undefined;
	}

	/** The `--app` sub-flags that pick which app and build, set ones only. */
	private appTarget(
		opts: AppFlagValues
	): Pick<EnsureOptions, "project" | "bundleId" | "variant" | "kind" | "bundleEnv"> {
		return {
			...(opts.project !== undefined ? { project: opts.project } : {}),
			...(opts.bundleId !== undefined ? { bundleId: opts.bundleId } : {}),
			...(opts.variant !== undefined ? { variant: opts.variant } : {}),
			...(opts.kind !== undefined ? { kind: opts.kind } : {}),
			...(opts.bundleEnv !== undefined ? { bundleEnv: opts.bundleEnv } : {}),
		};
	}

	/** `--app …` → ensure options (undefined without `--app`); the sub-flags need `--app`. */
	parseAppFlags(opts: AppFlagValues): Result<EnsureOptions | undefined> {
		const install = installFlags.parseInstallFlags(opts);
		if (!install.success) return install;
		if (opts.app) {
			if (this.kindWithVariant(opts)) return resultFactory.err("--kind and --variant can't be combined");
			return resultFactory.ok({ eas: opts.eas, build: opts.build, ...install.data, ...this.appTarget(opts) });
		}
		const sub = opts.project ?? opts.bundleId ?? opts.variant ?? opts.kind;
		if (sub !== undefined || !opts.eas || !opts.build || install.data.installMode !== undefined) {
			return resultFactory.err(
				"--project / --no-eas / --no-build / --bundle-id / --variant / --kind / --install-mode / --reset-keychain / --clean need --app"
			);
		}
		return resultFactory.ok(undefined);
	}

	/**
	 * With `--app` the app work runs under the claim spinner: report the lease the moment it is held,
	 * so the lines that follow read as happening on leased devices. The spinner text itself comes from `appPhaseProgress`.
	 */
	leasedProgress(
		spinner: Spinner,
		color: CommandContext["ui"]["color"],
		app: boolean
	): ((outcome: ClaimOutcome) => void) | undefined {
		if (!app) return undefined;
		return (outcome) => {
			spinner.log(`${color.green("✔")} ${sessionRules.leasedText(outcome)}`);
		};
	}

	/** With `--app`, the claim spinner follows what the app is really doing (see `appPhaseText`): building, fetching, repacking, installing. */
	appPhaseProgress(spinner: Spinner, app: boolean): LeaseArgs["onAppPhase"] {
		return app ? appPhaseHelpers.phaseTracker((text) => spinner.update(text)) : undefined;
	}
}

export const leaseOptions = new LeaseOptions();
