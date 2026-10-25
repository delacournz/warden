import type { DevtoolsFacet, DevtoolsResult } from "./devtools/devtools.types";
import type { SpanRunner } from "./runner/span";
import type { TraceEvent } from "./runner/trace";

/**
 * What the `app` / `device` fixtures need from the session. `Session` satisfies it structurally;
 * the runner (T3) mutates `signal`, `attemptDir` and `trace` per attempt, so fixtures read them at
 * call time, never at construction.
 */
export type FixtureSession = {
	/** absolute `WARDEN_E2E_OUT` (screenshot fallback when no attempt is running) */
	readonly out: string;
	/** the running attempt's deadline / cancel signal; every driver call honours it */
	readonly signal?: AbortSignal;
	/** `<out>/<specId>/<title-slug>-<hash6>` of the running attempt */
	readonly attemptDir?: string;
	/** the running attempt's `trace.jsonl` */
	readonly trace?: { write(event: TraceEvent): void };
	/** one reported step (`▸`/`▪` lines, `trace.jsonl`) that gives up when the attempt deadline aborts; absent = just run it */
	step?<T>(kind: string, label: string, fn: () => Promise<T>): Promise<T>;
	/** times one call as a trace-only `span` (`device.*`, `read.*`); absent = untraced */
	span?: SpanRunner;
	/** attaches the app's devtools on first call (the session shares one connection); absent = no devtools */
	devtools?(): Promise<DevtoolsResult<DevtoolsFacet>>;
	/** the facet if already attached; never attaches */
	peekDevtools?(): DevtoolsFacet | undefined;
};

/** Injected time: tests drive a fake clock. */
export type Clock = {
	now(): number;
	sleep(ms: number): Promise<void>;
};

export const systemClock: Clock = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
