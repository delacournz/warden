/** The record template; the extra instruments ride on top of it with `--instrument`. */
export const TIME_PROFILER_TEMPLATE = "Time Profiler";
export const HANGS_INSTRUMENT = "Hangs";
export const LEAK_INSTRUMENTS = ["Leaks", "Allocations"] as const;

export type RecordTarget =
	/** `udid` absent: attach host-side (the simulator's processes are host processes) */
	| { kind: "attach"; udid?: string; pid: number }
	/** Xcode 26.4+ deadlocks `--device`: record every process and filter rows by pid afterwards */
	| { kind: "all-processes" }
	/** cold launch of an `.app` on the simulator (`--leaks`) */
	| { kind: "launch"; udid: string; appPath: string; env: Readonly<Record<string, string>> };

export type RecordSpec = {
	output: string;
	instruments: readonly string[];
	target: RecordTarget;
	/** `--time-limit` in ms: a backstop so a lost `stop` cannot record forever */
	timeLimitMs?: number;
};

const timeLimit = (ms: number): string => `${Math.max(1, Math.ceil(ms / 1000))}s`;

/** `xcrun xctrace record …` for the Time Profiler template plus `instruments`. */
export function recordArgv(spec: RecordSpec): string[] {
	const argv = ["xcrun", "xctrace", "record", "--template", TIME_PROFILER_TEMPLATE];
	for (const instrument of spec.instruments) argv.push("--instrument", instrument);
	argv.push("--output", spec.output, "--no-prompt");
	if (spec.timeLimitMs !== undefined) argv.push("--time-limit", timeLimit(spec.timeLimitMs));
	const { target } = spec;
	if (target.kind === "attach") {
		if (target.udid !== undefined) argv.push("--device", target.udid);
		argv.push("--attach", String(target.pid));
	} else if (target.kind === "all-processes") argv.push("--all-processes");
	else {
		argv.push("--device", target.udid);
		for (const [key, value] of Object.entries(target.env)) argv.push("--env", `${key}=${value}`);
		argv.push("--launch", "--", target.appPath);
	}
	return argv;
}

/** `xctrace export --input <trace> --toc`: the table of contents (runs and the schemas each holds). */
export function exportTocArgv(trace: string): string[] {
	return ["xcrun", "xctrace", "export", "--input", trace, "--toc"];
}

/** XPath of one run's tables of `schema`. */
export function tableXpath(schema: string, run = 1): string {
	return `/trace-toc/run[@number="${run}"]/data/table[@schema="${schema}"]`;
}

/** `xctrace export --input <trace> --xpath … --output <file>`: a table streamed to disk, never held in memory. */
export function exportTableArgv(trace: string, schema: string, output: string, run = 1): string[] {
	return ["xcrun", "xctrace", "export", "--input", trace, "--xpath", tableXpath(schema, run), "--output", output];
}

export const listInstrumentsArgv = (): string[] => ["xcrun", "xctrace", "list", "instruments"];

/** `xctrace list instruments` → every instrument name (section headers like `== Standard Instruments ==` dropped). */
export function parseInstruments(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("=="));
}
