import { isAbsolute, resolve } from "node:path";
import { ok, type Result } from "@warden/types/result";
import { findWardenConfig } from "../builds/config";
import type { Platform } from "../types";
import type { BatchPresetConfig } from "./preset.schema";

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
	cmd: string[];
};

const absolute = (cwd: string, path: string) => (isAbsolute(path) ? path : resolve(cwd, path));

function jobsSource(preset: BatchPresetConfig, cwd: string): BatchJobsSource | undefined {
	if (preset.jobs) return { kind: "list", jobs: preset.jobs };
	const from = preset.jobsFrom;
	if (from === undefined) return undefined;
	if (typeof from !== "string") return { kind: "command", command: from.command };
	return from === "-" ? { kind: "stdin" } : { kind: "file", path: absolute(cwd, from) };
}

function readySpec(value: string, cwd: string): string {
	return value.startsWith("file:") ? `file:${absolute(cwd, value.slice("file:".length))}` : value;
}

function resolvePreset(name: string, preset: BatchPresetConfig, cwd: string, projectRoot?: string): BatchPreset {
	const { project: _project, jobs: _jobs, jobsFrom: _jobsFrom, serveReady, record, logs, label, ...rest } = preset;
	const jobs = jobsSource(preset, cwd);
	return {
		...rest,
		name,
		cwd,
		label: label ?? name,
		...(projectRoot !== undefined ? { projectRoot } : {}),
		...(serveReady !== undefined ? { serveReady: readySpec(serveReady, cwd) } : {}),
		...(record !== undefined ? { record: absolute(cwd, record) } : {}),
		...(logs !== undefined ? { logs: absolute(cwd, logs) } : {}),
		...(jobs ? { jobs } : {}),
	};
}

export type FindBatchPresetInput = {
	/** the invoking cwd */
	start: string;
	/** stop walking up here (git toplevel); default filesystem root */
	stopAt?: string;
	name: string;
};

/**
 * Look `name` up in the nearest `warden.config.json` (walking up from `start`). `preset` is
 * undefined when there is no config or no such preset; `names` lists the presets that exist.
 */
export function findBatchPreset(input: FindBatchPresetInput): Result<{ preset?: BatchPreset; names: string[] }> {
	const found = findWardenConfig(input.start, input.stopAt);
	if (!found.success) return found;
	if (!found.data) return ok({ names: [] });
	const { dir, config } = found.data;
	const batches = config.batches ?? {};
	const names = Object.keys(batches).sort();
	const preset = batches[input.name];
	if (!preset) return ok({ names });
	const project = config.projects?.find((p) => p.name === preset.project);
	const projectRoot = project ? resolve(dir, project.root) : undefined;
	return ok({ names, preset: resolvePreset(input.name, preset, projectRoot ?? dir, projectRoot) });
}
