/** What `xctrace export --toc` says about a trace: its runs and the table schemas each holds. */
export type TraceRun = {
	number: number;
	durationMs?: number;
	startDate?: string;
	/** attached / launched target process, when recorded against one */
	process?: { name: string; pid?: number };
	schemas: string[];
};

const RUN = /<run\s+number="(\d+)"[^>]*>([\s\S]*?)<\/run>/g;
const TABLE = /<table\s+([^>]*?)\/?>/g;

function attr(text: string, name: string): string | undefined {
	return new RegExp(`\\b${name}="([^"]*)"`).exec(text)?.[1];
}

/** The distinct `schema` names of every `<table>` in a run body. */
function tableSchemas(body: string): string[] {
	const schemas: string[] = [];
	TABLE.lastIndex = 0;
	for (let t = TABLE.exec(body); t !== null; t = TABLE.exec(body)) {
		const schema = attr(t[1] ?? "", "schema");
		if (schema !== undefined && !schemas.includes(schema)) schemas.push(schema);
	}
	return schemas;
}

/** The recorded target process of a run body, when there is one. */
function runProcess(body: string): TraceRun["process"] {
	const proc = /<process\s+([^>]*?)\/?>/.exec(body)?.[1];
	const name = proc === undefined ? undefined : attr(proc, "name");
	if (proc === undefined || name === undefined) return undefined;
	const pid = attr(proc, "pid");
	return { name, ...(pid === undefined ? {} : { pid: Number(pid) }) };
}

/** One `<run>` element as a `TraceRun`. */
function parseRun(number: number, body: string): TraceRun {
	const seconds = Number(/<duration>([\d.]+)<\/duration>/.exec(body)?.[1]);
	const startDate = /<start-date>([^<]+)<\/start-date>/.exec(body)?.[1];
	const process = runProcess(body);
	return {
		number,
		...(Number.isFinite(seconds) ? { durationMs: Math.round(seconds * 1000) } : {}),
		...(startDate === undefined ? {} : { startDate }),
		...(process === undefined ? {} : { process }),
		schemas: tableSchemas(body),
	};
}

export function parseToc(xml: string): TraceRun[] {
	const runs: TraceRun[] = [];
	RUN.lastIndex = 0;
	for (let m = RUN.exec(xml); m !== null; m = RUN.exec(xml)) runs.push(parseRun(Number(m[1]), m[2] ?? ""));
	return runs;
}

/** The first of `candidates` the run holds, else any schema whose name contains `fuzzy`. */
export function pickSchema(run: TraceRun, candidates: readonly string[], fuzzy?: string): string | undefined {
	return (
		candidates.find((c) => run.schemas.includes(c)) ??
		(fuzzy === undefined ? undefined : run.schemas.find((s) => s.includes(fuzzy)))
	);
}

export const SAMPLE_SCHEMAS = ["time-profile"] as const;
export const HANG_SCHEMAS = ["potential-hangs", "hang-risks", "hangs"] as const;
export const LEAK_SCHEMAS = ["leaks"] as const;
