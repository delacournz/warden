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

export class XctraceArgv {
	private timeLimit(ms: number): string {
		return `${Math.max(1, Math.ceil(ms / 1000))}s`;
	}

	/** `xcrun xctrace record …` for the Time Profiler template plus `instruments`. */
	recordArgv(spec: RecordSpec): string[] {
		const argv = ["xcrun", "xctrace", "record", "--template", TIME_PROFILER_TEMPLATE];
		for (const instrument of spec.instruments) argv.push("--instrument", instrument);
		argv.push("--output", spec.output, "--no-prompt");
		if (spec.timeLimitMs !== undefined) argv.push("--time-limit", this.timeLimit(spec.timeLimitMs));
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
	exportTocArgv(trace: string): string[] {
		return ["xcrun", "xctrace", "export", "--input", trace, "--toc"];
	}

	/** XPath of one run's tables of `schema`. */
	tableXpath(schema: string, run = 1): string {
		return `/trace-toc/run[@number="${run}"]/data/table[@schema="${schema}"]`;
	}

	/** `xctrace export --input <trace> --xpath … --output <file>`: a table streamed to disk, never held in memory. */
	exportTableArgv(trace: string, schema: string, output: string, run = 1): string[] {
		return [
			"xcrun",
			"xctrace",
			"export",
			"--input",
			trace,
			"--xpath",
			this.tableXpath(schema, run),
			"--output",
			output,
		];
	}

	listInstrumentsArgv(): string[] {
		return ["xcrun", "xctrace", "list", "instruments"];
	}

	/** `xctrace list instruments` → every instrument name (section headers like `== Standard Instruments ==` dropped). */
	parseInstruments(text: string): string[] {
		return text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("=="));
	}
}

export const xctraceArgv = new XctraceArgv();
