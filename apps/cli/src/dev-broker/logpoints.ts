import type { Fetch } from "@delacour/warden-e2e/devtools/devtools.types";
import type { DevtoolsSession } from "@delacour/warden-e2e/devtools/session";
import { isBundleUrl } from "@delacour/warden-perf/js/bundle-url";
import { ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import type { Broker } from "./broker";
import { type BrokerContext, type BrokerResult, brokerErr, type MethodHandler } from "./broker.types";
import type { BrokerExtension } from "./extensions";
import { createSourceMapCache, originalToGenerated, type SourceMapCache, type SourceMapError } from "./source-map";

/** Hits are console lines whose first argument starts with this prefix: `[logpoint:<id>]` (or `… error`). */
export const LOGPOINT_TAG_PREFIX = "[logpoint:";

/** The console tag of `id`'s hits. */
export const logpointTag = (id: string): string => `${LOGPOINT_TAG_PREFIX}${id}]`;

/** The logpoint id a console line belongs to (`[logpoint:ab] 3 4` -> `ab`), if any. */
export function logpointIdOf(text: string): string | undefined {
	if (!text.startsWith(LOGPOINT_TAG_PREFIX)) return undefined;
	const end = text.indexOf("]");
	return end < 0 ? undefined : text.slice(LOGPOINT_TAG_PREFIX.length, end);
}

const idSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/, "id: 1-40 letters, digits, `_`, `.` or `-`");

export const logpointAddSchema = z.strictObject({
	/** `src/x.tsx:42` or `src/x.tsx:42:7`: a path suffix inside the bundle, 1-based line and column */
	location: z.string().min(1),
	/** JavaScript expression evaluated in the scope of that line; its value is logged */
	expression: z.string().min(1),
	id: idSchema.optional(),
	/** remove the logpoint after this many hits */
	hits: z.number().int().positive().optional(),
});
export const logpointRemoveSchema = z.strictObject({ id: idSchema });
const noParams = z.strictObject({});

export type LogpointAddParams = z.infer<typeof logpointAddSchema>;
export type LogpointRemoveParams = z.infer<typeof logpointRemoveSchema>;

/** What `logpoint.add` / `logpoint.list` report about one logpoint. */
export type LogpointInfo = {
	id: string;
	location: string;
	expression: string;
	hits?: number;
	hitCount: number;
	/** false until the app's bundle is known and the breakpoint is set in it */
	armed: boolean;
	/** where the breakpoint actually sits (a line without code snaps to the next one that has some) */
	resolved?: { source: string; line: number; col: number };
	/** why it is not armed, when it is not */
	error?: string;
};

/** The wire shape of every `logpoint.*` method. */
export type LogpointMethods = {
	"logpoint.add": { params: LogpointAddParams; data: { logpoint: LogpointInfo } };
	"logpoint.list": { params: Record<string, never>; data: { logpoints: LogpointInfo[] } };
	"logpoint.remove": { params: LogpointRemoveParams; data: { removed: string } };
	"logpoint.clear": { params: Record<string, never>; data: { removed: string[] } };
};

/**
 * The breakpoint condition: logs `(<expression>)` under the logpoint's tag and returns `false`, so the app never
 * pauses. An exception in the expression is logged as `[logpoint:<id>] error <message>`. With `hits`, the page
 * counts too and stops logging after that many, so a hot line cannot flood the console before the broker has
 * removed the logpoint.
 */
export function logpointCondition(id: string, expression: string, hits?: number): string {
	const key = JSON.stringify(id);
	const gate =
		hits === undefined
			? ""
			: `var s=g.__wardenLogpoints||(g.__wardenLogpoints={});s[${key}]=(s[${key}]||0)+1;if(s[${key}]>${hits})return false;`;
	return `(function(){var g=globalThis;${gate}try{g.console.log(${JSON.stringify(logpointTag(id))},(${expression}\n));}catch(e){g.console.log(${JSON.stringify(`${logpointTag(id)} error`)},String(e));}return false;})()`;
}

/** `src/x.tsx:42[:7]` -> file, 1-based line, optional 1-based column. */
export function parseLocation(location: string): { file: string; line: number; col?: number } | undefined {
	const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(location);
	const [, file, line, col] = match ?? [];
	if (file === undefined || line === undefined || Number(line) < 1) return undefined;
	if (col !== undefined && Number(col) < 1) return undefined;
	return { file, line: Number(line), ...(col === undefined ? {} : { col: Number(col) }) };
}

type Bundle = { url: string; scriptId: string; sourceMapURL?: string };

type Arm = { scriptId: string; breakpointId: string };

type Logpoint = {
	id: string;
	location: string;
	file: string;
	line: number;
	col?: number;
	expression: string;
	hits?: number;
	hitCount: number;
	/** bundle URL -> the breakpoint set in that bundle's current script */
	arms: Map<string, Arm>;
	resolved?: { source: string; line: number; col: number };
	error?: string;
};

export type LogpointsOptions = { fetch?: Fetch };

const record = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The logpoint id a `Runtime.consoleAPICalled` event belongs to: its first argument carries the tag. */
function hitIdOf(params: unknown): string | undefined {
	const args = record(params).args;
	const text = Array.isArray(args) ? asString(record(args[0]).value) : undefined;
	return text === undefined ? undefined : logpointIdOf(text);
}

/** `Debugger.setBreakpointByUrl` for `lp` at a generated position; the new breakpoint id, or why not. */
async function setBreakpoint(
	session: DevtoolsSession,
	lp: Logpoint,
	bundle: Bundle,
	at: { generatedLine: number; generatedColumn: number }
): Promise<Result<string, SourceMapError>> {
	const remaining = lp.hits === undefined ? undefined : Math.max(1, lp.hits - lp.hitCount);
	const set = await session.send("Debugger.setBreakpointByUrl", {
		url: bundle.url,
		lineNumber: at.generatedLine,
		columnNumber: at.generatedColumn,
		condition: logpointCondition(lp.id, lp.expression, remaining),
	});
	if (!set.success) {
		return {
			success: false,
			error: { code: "fetch_failed", message: `Debugger.setBreakpointByUrl: ${set.error.message}` },
		};
	}
	const breakpointId = asString(record(set.data).breakpointId);
	if (breakpointId === undefined) {
		return {
			success: false,
			error: { code: "fetch_failed", message: "Debugger.setBreakpointByUrl returned no breakpointId" },
		};
	}
	return ok(breakpointId);
}

/** A valid `logpoint.add` request as a fresh, unarmed logpoint. */
function newLogpoint(params: unknown, taken: (id: string) => boolean, nextId: () => string): BrokerResult<Logpoint> {
	const parsed = logpointAddSchema.safeParse(params);
	if (!parsed.success) return brokerErr("bad_request", `logpoint.add: ${parsed.error.message}`);
	const where = parseLocation(parsed.data.location);
	if (!where) {
		return brokerErr(
			"bad_request",
			`logpoint.add: location must be <file>:<line>[:<col>], got ${parsed.data.location}`
		);
	}
	const id = parsed.data.id ?? nextId();
	if (taken(id)) return brokerErr("bad_request", `logpoint ${id} exists`, "remove it first or pick another --id");
	return ok({
		id,
		location: parsed.data.location,
		file: where.file,
		line: where.line,
		...(where.col === undefined ? {} : { col: where.col }),
		expression: parsed.data.expression,
		...(parsed.data.hits === undefined ? {} : { hits: parsed.data.hits }),
		hitCount: 0,
		arms: new Map(),
	});
}

const LEGACY_ERROR = brokerErr(
	"logpoints_unsupported",
	"logpoints need the Fusebox debugger; this app is on legacy Hermes debugging",
	"use `warden ui eval` or console logging instead"
);

/** Why a logpoint that armed nowhere is refused, or undefined when no bundle was there to try. */
function refusalFor(errors: readonly SourceMapError[]): BrokerResult<never> | undefined {
	if (errors.length === 0) return undefined;
	const worst = mostRelevant(errors);
	return worst ? mapError(worst) : brokerErr("bad_request", "logpoint could not be set");
}

/** `bad_request` for a map problem (the caller named a file the bundle does not have), with the reason. */
const mapError = (error: SourceMapError) => brokerErr("bad_request", error.message);

const MAP_ERROR_PRIORITY: readonly SourceMapError["code"][] = [
	"ambiguous_source",
	"no_mapping",
	"fetch_failed",
	"invalid_map",
	"source_not_found",
];

function mostRelevant(errors: readonly SourceMapError[]): SourceMapError | undefined {
	for (const code of MAP_ERROR_PRIORITY) {
		const found = errors.find((error) => error.code === code);
		if (found) return found;
	}
	return undefined;
}

/**
 * Logpoints for a dev session: `logpoint.add|list|remove|clear` on the broker. `Debugger` is enabled only while at
 * least one logpoint exists (its `scriptParsed` traffic costs). A logpoint is a conditional breakpoint whose
 * condition logs and returns false ({@link logpointCondition}), set with `Debugger.setBreakpointByUrl` at the
 * generated position of the original `file:line` in the app's bundle (Metro's source map). It is set again in
 * every new script of the bundle (a reload gets a new script id) and after a reconnect, and dropped with the
 * session. Needs a Fusebox target: legacy Hermes answers `logpoints_unsupported`.
 *
 * Hits are ordinary console lines (`[logpoint:<id>] <value>`), found with `console.query` (`grep: "[logpoint:"`)
 * and told apart by {@link logpointIdOf}; the broker counts them as they arrive for `hits`.
 */
export function createLogpointsExtension(options: LogpointsOptions = {}): BrokerExtension {
	return (broker: Broker, context) => {
		const cache: SourceMapCache = createSourceMapCache({
			metroUrl: context.metroUrl,
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		});
		const logpoints = new Map<string, Logpoint>();
		const bundles = new Map<string, Bundle>();
		let listening = false;
		let bound: { session: DevtoolsSession; offs: (() => void)[] } | undefined;
		let queue: Promise<unknown> = Promise.resolve();
		let counter = 0;

		/** One mutation at a time: scriptParsed handlers, adds, removes and re-arming never interleave. */
		const serial = <T>(work: () => Promise<T>): Promise<T> => {
			const run = queue.then(work, work);
			queue = run.catch(() => undefined);
			return run;
		};

		const info = (lp: Logpoint): LogpointInfo => ({
			id: lp.id,
			location: lp.location,
			expression: lp.expression,
			...(lp.hits === undefined ? {} : { hits: lp.hits }),
			hitCount: lp.hitCount,
			armed: lp.arms.size > 0,
			...(lp.resolved === undefined ? {} : { resolved: lp.resolved }),
			...(lp.arms.size === 0 && lp.error !== undefined ? { error: lp.error } : {}),
		});

		/** Set `lp`'s breakpoint in `bundle`. */
		async function arm(session: DevtoolsSession, lp: Logpoint, bundle: Bundle): Promise<SourceMapError | undefined> {
			const previous = lp.arms.get(bundle.url);
			if (previous?.scriptId === bundle.scriptId) return undefined;
			if (previous) {
				lp.arms.delete(bundle.url);
				await session.send("Debugger.removeBreakpoint", { breakpointId: previous.breakpointId });
			}
			const map = await cache.get(bundle.url, bundle.sourceMapURL);
			if (!map.success) return map.error;
			const at = originalToGenerated(map.data, lp.file, lp.line, lp.col);
			if (!at.success) return at.error;
			const set = await setBreakpoint(session, lp, bundle, at.data);
			if (!set.success) return set.error;
			lp.arms.set(bundle.url, { scriptId: bundle.scriptId, breakpointId: set.data });
			lp.resolved = { source: at.data.source, line: at.data.line, col: at.data.col };
			return undefined;
		}

		/** Arm every logpoint in `bundle`; the errors of those that do not fit it (their file is in another bundle). */
		async function armAll(session: DevtoolsSession, bundle: Bundle): Promise<Map<string, SourceMapError>> {
			const failed = new Map<string, SourceMapError>();
			for (const lp of logpoints.values()) {
				const error = await arm(session, lp, bundle);
				if (error) {
					failed.set(lp.id, error);
					lp.error = error.message;
				} else {
					delete lp.error;
				}
			}
			return failed;
		}

		const onScriptParsed = (params: unknown) => {
			if (!listening || !bound) return;
			const { scriptId, url, sourceMapURL } = record(params);
			if (typeof scriptId !== "string" || typeof url !== "string" || !isBundleUrl(url)) return;
			if (bundles.get(url)?.scriptId === scriptId) return;
			cache.invalidate(url);
			const bundle: Bundle = {
				url,
				scriptId,
				...(typeof sourceMapURL === "string" && sourceMapURL !== "" ? { sourceMapURL } : {}),
			};
			bundles.set(url, bundle);
			const { session } = bound;
			void serial(() => armAll(session, bundle)).catch((error) =>
				context.log(`logpoints: arming failed: ${String(error)}`)
			);
		};

		const onConsole = (params: unknown) => {
			const id = hitIdOf(params);
			const lp = id === undefined ? undefined : logpoints.get(id);
			if (!lp) return;
			lp.hitCount++;
			if (lp.hits !== undefined && lp.hitCount >= lp.hits) void serial(() => removeOne(lp.id));
		};

		/** Forget what the old Debugger session knew and, while logpoints exist, enable it again (it replays scripts). */
		async function reset(session: DevtoolsSession): Promise<void> {
			for (const url of bundles.keys()) cache.invalidate(url);
			bundles.clear();
			listening = false;
			for (const lp of logpoints.values()) lp.arms.clear();
			if (logpoints.size > 0) await enable(session);
		}

		async function enable(session: DevtoolsSession): Promise<BrokerResult<null>> {
			if (listening) return ok(null);
			listening = true;
			const enabled = await session.send("Debugger.enable");
			if (!enabled.success) {
				listening = false;
				return brokerErr(enabled.error.code, `Debugger.enable: ${enabled.error.message}`);
			}
			return ok(null);
		}

		const unbind = () => {
			for (const off of bound?.offs ?? []) off();
			bound = undefined;
		};

		function bind(session: DevtoolsSession): void {
			if (bound?.session === session) return;
			unbind();
			bound = {
				session,
				offs: [
					session.onCdp("Debugger.scriptParsed", onScriptParsed),
					session.onCdp("Runtime.consoleAPICalled", onConsole),
					session.on("reconnected", () => void serial(() => reset(session)).catch(() => undefined)),
				],
			};
		}

		async function disable(): Promise<void> {
			listening = false;
			bundles.clear();
			const session = bound?.session;
			unbind();
			await session?.send("Debugger.disable");
		}

		/** Remove `id`'s breakpoints (best effort: the page may be gone) and the Debugger with the last logpoint. */
		async function removeOne(id: string): Promise<boolean> {
			const lp = logpoints.get(id);
			if (!lp) return false;
			logpoints.delete(id);
			if (bound) {
				for (const { breakpointId } of lp.arms.values()) {
					await bound.session.send("Debugger.removeBreakpoint", { breakpointId });
				}
			}
			if (logpoints.size === 0) await disable();
			return true;
		}

		/** Register `lp` and arm it in every bundle known so far; refuse it when none of them has its file. */
		async function armNew(session: DevtoolsSession, lp: Logpoint): Promise<BrokerResult<{ logpoint: LogpointInfo }>> {
			logpoints.set(lp.id, lp);
			const errors: SourceMapError[] = [];
			for (const bundle of bundles.values()) {
				const error = await arm(session, lp, bundle);
				if (error) errors.push(error);
			}
			if (lp.arms.size === 0) {
				const refusal = refusalFor(errors);
				if (refusal) {
					await removeOne(lp.id);
					return refusal;
				}
				lp.error = "the app's bundle is not loaded yet; the logpoint arms when it is";
			}
			return ok({ logpoint: info(lp) });
		}

		async function addOne(params: unknown, ctx: BrokerContext): Promise<BrokerResult<{ logpoint: LogpointInfo }>> {
			const created = newLogpoint(
				params,
				(id) => logpoints.has(id),
				() => `lp${++counter}`
			);
			if (!created.success) return created;
			const session = ctx.requireSession();
			if (!session.success) return session;
			if (!session.data.target.fusebox) return LEGACY_ERROR;
			bind(session.data);
			const enabled = await enable(session.data);
			if (!enabled.success) return enabled;
			return armNew(session.data, created.data);
		}

		const add: MethodHandler = (params, ctx) => serial(() => addOne(params, ctx));

		const list: MethodHandler = async (params) => {
			const parsed = noParams.safeParse(params ?? {});
			if (!parsed.success) return brokerErr("bad_request", `logpoint.list: ${parsed.error.message}`);
			return ok({ logpoints: [...logpoints.values()].map(info) });
		};

		const remove: MethodHandler = (params) =>
			serial(async () => {
				const parsed = logpointRemoveSchema.safeParse(params);
				if (!parsed.success) return brokerErr("bad_request", `logpoint.remove: ${parsed.error.message}`);
				const removed = await removeOne(parsed.data.id);
				if (!removed) {
					return brokerErr(
						"bad_request",
						`no logpoint ${parsed.data.id}`,
						`have: ${[...logpoints.keys()].join(", ") || "none"}`
					);
				}
				return ok({ removed: parsed.data.id });
			});

		const clear: MethodHandler = (params) =>
			serial(async () => {
				const parsed = noParams.safeParse(params ?? {});
				if (!parsed.success) return brokerErr("bad_request", `logpoint.clear: ${parsed.error.message}`);
				const ids = [...logpoints.keys()];
				for (const id of ids) await removeOne(id);
				return ok({ removed: ids });
			});

		const removers: (() => void)[] = [];
		const handlers: [string, MethodHandler][] = [
			["logpoint.add", add],
			["logpoint.list", list],
			["logpoint.remove", remove],
			["logpoint.clear", clear],
		];
		for (const [name, handler] of handlers) {
			const registered = broker.registerMethod(name, handler);
			if (registered.success) removers.push(registered.data);
			else context.log(`logpoints: ${registered.error.message}`);
		}
		removers.push(
			broker.onAttach((session) => {
				if (logpoints.size === 0) return;
				bind(session);
				void serial(() => reset(session)).catch(() => undefined);
			})
		);

		return () => {
			for (const remove of removers) remove();
			const session = bound?.session;
			const wasListening = listening;
			unbind();
			logpoints.clear();
			bundles.clear();
			listening = false;
			if (wasListening) void session?.send("Debugger.disable");
		};
	};
}

/** The extension `warden dev` installs (see {@link createLogpointsExtension} to inject a `fetch`). */
export const logpointsExtension: BrokerExtension = createLogpointsExtension();
