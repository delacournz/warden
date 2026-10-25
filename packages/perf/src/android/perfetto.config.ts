/** Package names land in a textproto string and in SQL; only plain Android package characters pass. */
export const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;

export const PERF_BUFFER_KB = 65_536;
export const AUX_BUFFER_KB = 16_384;
export const DEFAULT_SAMPLE_HZ = 100;

export const FTRACE_EVENTS = [
	"sched/sched_switch",
	"sched/sched_waking",
	"sched/sched_wakeup_new",
	"sched/sched_process_exit",
	"sched/sched_process_free",
	"task/task_newtask",
	"task/task_rename",
	"binder/binder_transaction",
	"binder/binder_transaction_received",
] as const;

export const ATRACE_CATEGORIES = ["view", "gfx", "wm", "am", "input", "dalvik"] as const;

export type PerfettoConfigOptions = {
	packageName: string;
	/** the trace stops itself after this long (the session cap) */
	durationMs: number;
	sampleHz?: number;
	/** kernel frames need a rooted/userdebug device and slow sampling; off by default */
	kernelFrames?: boolean;
};

const str = (s: string): string => JSON.stringify(s);

/**
 * The Perfetto trace config (text proto) for profiling one app: callstack sampling scoped to its process,
 * scheduler/binder ftrace plus atrace categories, SurfaceFlinger frame timeline and 1s process stats.
 * `undefined` when `packageName` is not a plausible package.
 */
export function buildPerfettoConfig(opts: PerfettoConfigOptions): string | undefined {
	if (!PACKAGE_NAME.test(opts.packageName)) return undefined;
	const hz = opts.sampleHz ?? DEFAULT_SAMPLE_HZ;
	const lines = [
		`buffers { size_kb: ${PERF_BUFFER_KB} fill_policy: RING_BUFFER }`,
		`buffers { size_kb: ${AUX_BUFFER_KB} fill_policy: RING_BUFFER }`,
		`duration_ms: ${Math.max(1, Math.floor(opts.durationMs))}`,
		"write_into_file: true",
		"file_write_period_ms: 2500",
		"data_sources {",
		"  config {",
		'    name: "linux.perf"',
		"    target_buffer: 1",
		"    perf_event_config {",
		`      timebase { frequency: ${hz} counter: SW_CPU_CLOCK timestamp_clock: PERF_CLOCK_MONOTONIC }`,
		"      callstack_sampling {",
		`        scope { target_cmdline: ${str(opts.packageName)} }`,
		`        kernel_frames: ${opts.kernelFrames === true}`,
		"      }",
		"    }",
		"  }",
		"}",
		"data_sources {",
		"  config {",
		'    name: "linux.ftrace"',
		"    target_buffer: 0",
		"    ftrace_config {",
		...FTRACE_EVENTS.map((e) => `      ftrace_events: ${str(e)}`),
		...ATRACE_CATEGORIES.map((c) => `      atrace_categories: ${str(c)}`),
		`      atrace_apps: ${str(opts.packageName)}`,
		"    }",
		"  }",
		"}",
		"data_sources {",
		"  config {",
		'    name: "android.surfaceflinger.frametimeline"',
		"    target_buffer: 1",
		"  }",
		"}",
		"data_sources {",
		"  config {",
		'    name: "linux.process_stats"',
		"    target_buffer: 1",
		"    process_stats_config { scan_all_processes_on_start: true proc_stats_poll_ms: 1000 }",
		"  }",
		"}",
	];
	return `${lines.join("\n")}\n`;
}
