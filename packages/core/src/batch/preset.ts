import { isAbsolute, resolve } from "node:path";
import { projectConfig } from "@delacour/warden-builds/config";
import { appOptionReader, type InstallMode } from "@delacour/warden-config/app-option.schema";
import type { BatchPresetConfig } from "@delacour/warden-config/preset.schema";
import type { Platform } from "@delacour/warden-store/types";
import { type Result, resultFactory } from "@delacour/warden-types/result";

/** Where a batch's jobs come from. */
export type BatchJobsSource =
	| { kind: "list"; jobs: string[] }
	| { kind: "stdin" }
	| { kind: "file"; path: string }
	/** `sh -c` in the batch cwd; stdout lines are the jobs, nonzero exit is an error */
	| { kind: "command"; command: string };

/** A `batches.<name>` preset with its paths resolved against `cwd` and the label defaulted. */
export type BatchPreset = {
	name: string;
	/** serve / jobs / `jobsFrom.command` run here: the project root, else the config file's dir */
	cwd: string;
	/** root of `project` (for `app`) */
	projectRoot?: string;
	platform: Platform;
	count?: number;
	max?: number;
	profile?: string;
	runtime?: string;
	label: string;
	ttl?: string;
	wait?: string;
	ports?: string[];
	app?: boolean;
	/** `app: { installMode }`: reset the installed app (`clean`: fresh data, `reinstall`: uninstall + install) */
	installMode?: InstallMode;
	/** `app: { installMode, resetKeychain: true }`: also reset the iOS sim keychain */
	resetKeychain?: true;
	/** `app: { variant }`: install that project variant's build */
	variant?: string;
	retry?: number;
	passes?: number;
	env?: Record<string, string>;
	serve?: string;
	/** `file:` paths made absolute */
	serveReady?: string;
	serveTimeout?: string;
	jobs?: BatchJobsSource;
	record?: string;
	logs?: string;
	/** the preset's `headless`, else the top-level one (undefined: neither sets it) */
	headless?: boolean;
	/** the preset's `slim`, else the top-level one (undefined: neither sets it) */
	slim?: NonNullable<BatchPresetConfig["slim"]>;
	/** the preset's `biometrics`, else the top-level one (undefined: neither sets it) */
	biometrics?: boolean;
	cmd: string[];
};

export type FindBatchPresetInput = {
	/** the invoking cwd */
	start: string;
	/** stop walking up here (git toplevel); default filesystem root */
	stopAt?: string;
	/** the environment a config function receives and `WARDEN_HOME` is read from */
	env: Record<string, string | undefined>;
	name: string;
};

export class BatchPresets {
	/** `file:` probes made absolute against `cwd`; other probes unchanged. */
	readySpec(value: string, cwd: string): string {
		return value.startsWith("file:") ? `file:${this.absolute(cwd, value.slice("file:".length))}` : value;
	}

	/**
	 * Look `name` up in the nearest warden config (walking up from `start`). `preset` is
	 * undefined when there is no config or no such preset; `names` lists the presets that exist.
	 */
	find(input: FindBatchPresetInput): Result<{ preset?: BatchPreset; names: string[] }> {
		const found = projectConfig.find(input.start, input.stopAt, input.env);
		if (!found.success) return found;
		if (!found.data) return resultFactory.ok({ names: [] });
		const { dir, config } = found.data;
		const batches = config.batches ?? {};
		const names = Object.keys(batches).sort();
		const preset = batches[input.name];
		if (!preset) return resultFactory.ok({ names });
		const project = config.projects?.find((p) => p.name === preset.project);
		const projectRoot = project ? resolve(dir, project.root) : undefined;
		return resultFactory.ok({
			names,
			preset: this.resolvePreset(
				input.name,
				preset,
				projectRoot ?? dir,
				projectRoot,
				config.headless,
				config.slim,
				config.biometrics
			),
		});
	}

	private absolute(cwd: string, path: string): string {
		return isAbsolute(path) ? path : resolve(cwd, path);
	}

	private jobsSource(preset: BatchPresetConfig, cwd: string): BatchJobsSource | undefined {
		if (preset.jobs) return { kind: "list", jobs: preset.jobs };
		const from = preset.jobsFrom;
		if (from === undefined) return undefined;
		if (typeof from !== "string") return { kind: "command", command: from.command };
		return from === "-" ? { kind: "stdin" } : { kind: "file", path: this.absolute(cwd, from) };
	}

	/** only the settings that are set (preset first, then the top-level default) */
	private inherited(v: Pick<BatchPreset, "headless" | "slim" | "biometrics">): Partial<BatchPreset> {
		return {
			...(v.headless !== undefined ? { headless: v.headless } : {}),
			...(v.slim !== undefined ? { slim: v.slim } : {}),
			...(v.biometrics !== undefined ? { biometrics: v.biometrics } : {}),
		};
	}

	private resolvePreset(
		name: string,
		preset: BatchPresetConfig,
		cwd: string,
		projectRoot?: string,
		defaultHeadless?: boolean,
		defaultSlim?: BatchPresetConfig["slim"],
		defaultBiometrics?: boolean
	): BatchPreset {
		const {
			headless: ownHeadless,
			project: _project,
			jobs: _jobs,
			jobsFrom: _jobsFrom,
			app: appOption,
			serveReady,
			record,
			logs,
			label,
			...rest
		} = preset;
		const { app, installMode, resetKeychain, variant } = appOptionReader.appSwitches(appOption);
		const jobs = this.jobsSource(preset, cwd);
		return {
			...rest,
			name,
			cwd,
			label: label ?? name,
			...(appOption !== undefined ? { app } : {}),
			...(installMode !== undefined ? { installMode } : {}),
			...(resetKeychain ? { resetKeychain } : {}),
			...(variant !== undefined ? { variant } : {}),
			...(projectRoot !== undefined ? { projectRoot } : {}),
			...(serveReady !== undefined ? { serveReady: this.readySpec(serveReady, cwd) } : {}),
			...(record !== undefined ? { record: this.absolute(cwd, record) } : {}),
			...(logs !== undefined ? { logs: this.absolute(cwd, logs) } : {}),
			...(jobs ? { jobs } : {}),
			...this.inherited({
				headless: ownHeadless ?? defaultHeadless,
				slim: preset.slim ?? defaultSlim,
				biometrics: preset.biometrics ?? defaultBiometrics,
			}),
		};
	}
}

export const batchPresets = new BatchPresets();
