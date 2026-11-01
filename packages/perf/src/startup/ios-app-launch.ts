import { type Result, resultFactory } from "@delacour/warden-types/result";

/** Schemas the App Launch template can carry its launch periods in, best first. */
export const LAUNCH_SCHEMAS: readonly string[] = ["life-cycle-period", "app-launch"];

export type LaunchPeriod = { name: string; durationMs: number };

type Cell = { tag: string; text: string; fmt: string | undefined };

const ELEMENT = /<([\w-]+)((?:\s+[\w-]+=(?:"[^"]*"|'[^']*'))*)\s*(?:\/>|>([^<]*)<\/\1>)/g;

export class IosAppLaunch {
	/** `simctl launch` prints `<bundle>: <pid>`. */
	parseSimctlLaunch(stdout: string): number | undefined {
		const pid = /:\s*(\d+)\s*$/m.exec(stdout)?.[1];
		return pid === undefined ? undefined : Number(pid);
	}

	/** `simctl launch --terminate-running-process`: the cold launch the `approx` method times. */
	simctlLaunchArgv(udid: string, bundleId: string, terminateRunning: boolean): string[] {
		return ["xcrun", "simctl", "launch", ...(terminateRunning ? ["--terminate-running-process"] : []), udid, bundleId];
	}

	/** xctrace's App Launch template against a simulator, launching the installed `.app` itself. */
	xctraceLaunchArgv(udid: string, appPath: string, traceOut: string, timeLimit = "15s"): string[] {
		return [
			"xcrun",
			"xctrace",
			"record",
			"--template",
			"App Launch",
			"--device",
			udid,
			"--output",
			traceOut,
			"--time-limit",
			timeLimit,
			"--no-prompt",
			"--launch",
			"--",
			appPath,
		];
	}

	xctraceTocArgv(trace: string): string[] {
		return ["xcrun", "xctrace", "export", "--input", trace, "--toc"];
	}

	xctraceTableArgv(trace: string, schema: string): string[] {
		return [
			"xcrun",
			"xctrace",
			"export",
			"--input",
			trace,
			"--xpath",
			`/trace-toc/run[@number="1"]/data/table[@schema="${schema}"]`,
		];
	}

	/** The first launch schema the `--toc` document lists. */
	pickLaunchSchema(toc: string): string | undefined {
		return LAUNCH_SCHEMAS.find((schema) => toc.includes(`schema="${schema}"`));
	}

	private attr(attrs: string, name: string): string | undefined {
		return new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`)
			.exec(attrs)
			?.slice(1)
			.find((v) => v !== undefined);
	}

	/** The typed cells of one `<row>`; a `ref` cell is the earlier cell with that `id`, which `byId` remembers across rows. */
	private rowCells(rowXml: string, byId: Map<string, Cell>): Cell[] {
		const cells: Cell[] = [];
		for (const [, tag = "", attrs = "", text = ""] of rowXml.matchAll(ELEMENT)) {
			const id = this.attr(attrs, "id");
			const ref = this.attr(attrs, "ref");
			const cell = ref === undefined ? { tag, text, fmt: this.attr(attrs, "fmt") } : byId.get(ref);
			if (cell === undefined) continue;
			if (id !== undefined) byId.set(id, cell);
			cells.push(cell);
		}
		return cells;
	}

	private periodOf(cells: readonly Cell[]): LaunchPeriod | undefined {
		const duration = cells.find((c) => c.tag === "duration" && /^\d+$/.test(c.text));
		const name = cells.find((c) => c.tag === "string");
		if (duration === undefined || name === undefined) return undefined;
		return { name: name.fmt ?? name.text, durationMs: Math.round(Number(duration.text) / 1e6) };
	}

	/**
	 * SPIKE: parse an `xctrace export` table of launch periods. Handwritten to the export format (`<row>` of typed
	 * cells, repeated values as `ref="<id>"`); not yet confirmed against a simulator trace. A period is a row with a
	 * `duration` (ns) and a string cell naming it.
	 */
	parseLaunchPeriods(xml: string): Result<LaunchPeriod[], string> {
		if (!xml.includes("<row")) return resultFactory.err("no rows in the xctrace export");
		const byId = new Map<string, Cell>();
		const periods = [...xml.matchAll(/<row>([\s\S]*?)<\/row>/g)].flatMap(
			(row) => this.periodOf(this.rowCells(row[1] ?? "", byId)) ?? []
		);
		return periods.length === 0
			? resultFactory.err("no launch periods in the xctrace export")
			: resultFactory.ok(periods);
	}

	/** Time to first frame: the "Total App Launch" period, else the longest period naming a launch. */
	launchDurationMs(periods: readonly LaunchPeriod[]): number | undefined {
		const total = periods.find((p) => /total app launch/i.test(p.name));
		if (total) return total.durationMs;
		const launches = periods.filter((p) => /launch/i.test(p.name)).map((p) => p.durationMs);
		return launches.length === 0 ? undefined : Math.max(...launches);
	}
}

export const iosAppLaunch = new IosAppLaunch();
