import { z } from "zod";
import { evaluateValue, type JsCdp } from "../js/js.types";
import { PROFILER_SCRIPT } from "./profiler.script";
import {
	type Causes,
	type Commit,
	type CommitsFile,
	type FiberRender,
	type ReactErrorCode,
	type ReactResult,
	reactErr,
	reactOk,
} from "./react.types";

const ERROR_CODES: readonly ReactErrorCode[] = [
	"rn_too_old",
	"release_build",
	"devtools_backend_missing",
	"session_active",
	"not_profiling",
	"cdp_failed",
	"invalid_data",
];

const failureSchema = z.object({
	ok: z.literal(false),
	code: z.string(),
	message: z.string(),
	hint: z.string().optional(),
	owner: z.string().optional(),
});

const pair = z.tuple([z.number(), z.number()]);

const changeSchema = z.object({
	p: z.array(z.string()).nullable(),
	st: z.union([z.boolean(), z.array(z.string())]).nullable(),
	h: z.array(z.number()).nullable(),
	x: z.union([z.boolean(), z.array(z.string())]).nullable(),
	f: z.number(),
});

const rawCommitSchema = z.object({
	t: z.number(),
	dur: z.number(),
	eff: z.number(),
	pas: z.number(),
	upd: z.array(z.string()),
	a: z.array(pair),
	s: z.array(pair),
	c: z.array(z.tuple([z.number(), changeSchema])),
});

const rawStopSchema = z.object({
	ok: z.literal(true),
	anchor: z.object({
		startedWall: z.number(),
		startedPerf: z.number(),
		stoppedWall: z.number(),
		stoppedPerf: z.number(),
	}),
	dev: z.boolean().optional(),
	roots: z.array(
		z.object({ rootID: z.union([z.number(), z.string()]), name: z.string(), commits: z.array(rawCommitSchema) })
	),
	names: z.record(z.string(), z.string()),
	parents: z.record(z.string(), z.number()),
	memo: z.record(z.string(), z.number()),
	compiled: z.record(z.string(), z.number()),
	sources: z.record(z.string(), z.object({ file: z.string().optional(), line: z.number().optional() }).loose()),
});
type RawStop = z.infer<typeof rawStopSchema>;

/** The injected script's JSON reply, or the typed failure it carried. */
function parseReply<T extends z.ZodType>(value: unknown, schema: T): ReactResult<z.infer<T>> {
	if (typeof value !== "string") return reactErr("invalid_data", "the profiler script returned no data");
	let json: unknown;
	try {
		json = JSON.parse(value);
	} catch {
		return reactErr("invalid_data", "the profiler script returned invalid JSON");
	}
	const failed = failureSchema.safeParse(json);
	if (failed.success) {
		const code = ERROR_CODES.find((c) => c === failed.data.code) ?? "cdp_failed";
		return reactErr(code, failed.data.message, { hint: failed.data.hint, owner: failed.data.owner });
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) return reactErr("invalid_data", `unexpected profiler reply: ${parsed.error.issues[0]?.message}`);
	return reactOk(parsed.data);
}

async function run<T extends z.ZodType>(
	cdp: JsCdp,
	config: Record<string, unknown>,
	schema: T
): Promise<ReactResult<z.infer<T>>> {
	const expression = `(${PROFILER_SCRIPT})(${JSON.stringify(config)}, globalThis)`;
	const value = await evaluateValue(cdp, expression);
	if (!value.success) return reactErr("cdp_failed", value.error.message);
	return parseReply(value.data, schema);
}

const startSchema = z.object({
	ok: z.literal(true),
	startedWall: z.number(),
	startedPerf: z.number(),
	dev: z.boolean(),
	rn: z.string().nullable(),
	bootstrapped: z.boolean(),
});
export type ReactStart = Omit<z.infer<typeof startSchema>, "ok">;

export type ReactOwnerOptions = { owner: string; force?: boolean };

/**
 * Begin React profiling in the app's runtime. State lives in the JS runtime, not the socket, so `stopReactProfile`
 * may run on a later connection. Fails with `rn_too_old`, `release_build`, `devtools_backend_missing`, or
 * `session_active` (another owner holds it and `force` is not set).
 */
export async function startReactProfile(cdp: JsCdp, options: ReactOwnerOptions): Promise<ReactResult<ReactStart>> {
	const started = await run(cdp, { action: "start", owner: options.owner, force: options.force === true }, startSchema);
	if (!started.success) return started;
	const { ok: _ok, ...rest } = started.data;
	return reactOk(rest);
}

const statusSchema = z.object({
	ok: z.literal(true),
	profiling: z.boolean(),
	owner: z.object({ owner: z.string(), startedAt: z.number(), heartbeat: z.number() }).nullable(),
	renderers: z.number(),
});
export type ReactStatus = Omit<z.infer<typeof statusSchema>, "ok">;

/** Who holds React profiling in the app, and whether anything is recording. */
export async function reactProfileStatus(cdp: JsCdp): Promise<ReactResult<ReactStatus>> {
	const status = await run(cdp, { action: "status" }, statusSchema);
	if (!status.success) return status;
	const { ok: _ok, ...rest } = status.data;
	return reactOk(rest);
}

/** End React profiling and return its commits (the flattened `getProfilingData()`). */
export async function stopReactProfile(
	cdp: JsCdp,
	options: ReactOwnerOptions & { hostWallMs?: number }
): Promise<ReactResult<CommitsFile>> {
	const stopped = await run(
		cdp,
		{ action: "stop", owner: options.owner, force: options.force === true },
		rawStopSchema
	);
	if (!stopped.success) return stopped;
	return reactOk(buildCommits(stopped.data, options.hostWallMs));
}

function causesOf(change: z.infer<typeof changeSchema> | undefined): Causes | null {
	if (change === undefined) return null;
	const nonEmpty = (v: boolean | string[] | null) => (Array.isArray(v) ? v.length > 0 : v === true);
	return {
		firstMount: change.f === 1,
		props: change.p ?? [],
		state: nonEmpty(change.st),
		hooks: change.h ?? [],
		context: nonEmpty(change.x),
	};
}

function sourcesOf(raw: RawStop["sources"]): CommitsFile["sources"] {
	const out: CommitsFile["sources"] = {};
	for (const [name, src] of Object.entries(raw)) {
		if (typeof src.file === "string" && src.file !== "") out[name] = { file: src.file, line: src.line ?? 0 };
	}
	return out;
}

/** Flatten the injected script's per-root commit lists into one time-ordered commit list. */
export function buildCommits(raw: RawStop, hostWallMs?: number): CommitsFile {
	const { anchor } = raw;
	const nameOf = (id: number) => raw.names[String(id)] ?? `Unknown#${id}`;
	const commits: Omit<Commit, "index">[] = [];
	for (const root of raw.roots) {
		for (const c of root.commits) {
			const self = new Map(c.s);
			const changes = new Map(c.c);
			const fibers: FiberRender[] = c.a.map(([id, actualMs]) => {
				const parent = raw.parents[String(id)];
				return {
					id,
					name: nameOf(id),
					...(parent === undefined ? {} : { parent: nameOf(parent) }),
					actualMs,
					selfMs: self.get(id) ?? 0,
					causes: causesOf(changes.get(id)),
					memo: raw.memo[String(id)] === 1,
					compiler: raw.compiled[String(id)] === 1,
				};
			});
			// the backend stamps a commit when it finishes, in ms since profiling began: its work started `dur` earlier
			const startMs = Math.max(0, c.t - c.dur);
			commits.push({
				root: root.name,
				startMs,
				wallMs: anchor.startedWall + startMs,
				durationMs: c.dur,
				effectMs: c.eff,
				passiveEffectMs: c.pas,
				updaters: c.upd,
				fibers,
			});
		}
	}
	commits.sort((a, b) => a.startMs - b.startMs);
	const warnings: string[] = [];
	if (commits.length === 0) warnings.push("no commits were recorded: nothing rendered while profiling");
	if (commits.some((c) => c.fibers.some((f) => f.name.startsWith("Unknown#")))) {
		warnings.push("some components could not be named (this DevTools backend does not expose fiber ids)");
	}
	return {
		version: 1,
		anchor: {
			startedWallMs: anchor.startedWall,
			startedPerfMs: anchor.startedPerf,
			stoppedWallMs: anchor.stoppedWall,
			...(hostWallMs === undefined ? {} : { hostWallMs }),
		},
		...(raw.dev === undefined ? {} : { dev: raw.dev }),
		commits: commits.map((c, index) => ({ index, ...c })),
		sources: sourcesOf(raw.sources),
		warnings,
	};
}
