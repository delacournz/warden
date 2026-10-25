import { err, ok, type Result } from "@delacour/warden-types/result";

/** `simctl launch` prints `<bundle>: <pid>`. */
export function parseSimctlLaunch(stdout: string): number | undefined {
	const pid = /:\s*(\d+)\s*$/m.exec(stdout)?.[1];
	return pid === undefined ? undefined : Number(pid);
}

/** `simctl launch --terminate-running-process`: the cold launch the `approx` method times. */
export const simctlLaunchArgv = (udid: string, bundleId: string, terminateRunning: boolean): string[] => [
	"xcrun",
	"simctl",
	"launch",
	...(terminateRunning ? ["--terminate-running-process"] : []),
	udid,
	bundleId,
];

/** xctrace's App Launch template against a simulator, launching the installed `.app` itself. */
export const xctraceLaunchArgv = (udid: string, appPath: string, traceOut: string, timeLimit = "15s"): string[] => [
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

export const xctraceTocArgv = (trace: string): string[] => ["xcrun", "xctrace", "export", "--input", trace, "--toc"];

export const xctraceTableArgv = (trace: string, schema: string): string[] => [
	"xcrun",
	"xctrace",
	"export",
	"--input",
	trace,
	"--xpath",
	`/trace-toc/run[@number="1"]/data/table[@schema="${schema}"]`,
];

/** Schemas the App Launch template can carry its launch periods in, best first. */
export const LAUNCH_SCHEMAS: readonly string[] = ["life-cycle-period", "app-launch"];

/** The first launch schema the `--toc` document lists. */
export function pickLaunchSchema(toc: string): string | undefined {
	return LAUNCH_SCHEMAS.find((schema) => toc.includes(`schema="${schema}"`));
}

export type LaunchPeriod = { name: string; durationMs: number };

type Cell = { tag: string; text: string; fmt: string | undefined };

const ELEMENT = /<([\w-]+)((?:\s+[\w-]+=(?:"[^"]*"|'[^']*'))*)\s*(?:\/>|>([^<]*)<\/\1>)/g;
const attr = (attrs: string, name: string): string | undefined =>
	new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`)
		.exec(attrs)
		?.slice(1)
		.find((v) => v !== undefined);

/** The typed cells of one `<row>`; a `ref` cell is the earlier cell with that `id`, which `byId` remembers across rows. */
function rowCells(rowXml: string, byId: Map<string, Cell>): Cell[] {
	const cells: Cell[] = [];
	for (const [, tag = "", attrs = "", text = ""] of rowXml.matchAll(ELEMENT)) {
		const id = attr(attrs, "id");
		const ref = attr(attrs, "ref");
		const cell = ref === undefined ? { tag, text, fmt: attr(attrs, "fmt") } : byId.get(ref);
		if (cell === undefined) continue;
		if (id !== undefined) byId.set(id, cell);
		cells.push(cell);
	}
	return cells;
}

function periodOf(cells: readonly Cell[]): LaunchPeriod | undefined {
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
export function parseLaunchPeriods(xml: string): Result<LaunchPeriod[], string> {
	if (!xml.includes("<row")) return err("no rows in the xctrace export");
	const byId = new Map<string, Cell>();
	const periods = [...xml.matchAll(/<row>([\s\S]*?)<\/row>/g)].flatMap(
		(row) => periodOf(rowCells(row[1] ?? "", byId)) ?? []
	);
	return periods.length === 0 ? err("no launch periods in the xctrace export") : ok(periods);
}

/** Time to first frame: the "Total App Launch" period, else the longest period naming a launch. */
export function launchDurationMs(periods: readonly LaunchPeriod[]): number | undefined {
	const total = periods.find((p) => /total app launch/i.test(p.name));
	if (total) return total.durationMs;
	const launches = periods.filter((p) => /launch/i.test(p.name)).map((p) => p.durationMs);
	return launches.length === 0 ? undefined : Math.max(...launches);
}
