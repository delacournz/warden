import type { App } from "../app";
import type { Device } from "../device";
import type { Platform } from "../driver/driver.types";
import type { E2eError } from "../errors";
import type { Screen } from "../screen/screen";
import type { Session } from "../session";
import type { TraceWriter } from "./trace";

export type { App, Device, Screen };

/** What every test receives from the runner; `test.extend` adds to it. */
export type TestFixtures = BaseFixtures;

/** What every test receives; `test.extend` adds to it. */
export type BaseFixtures = { app: App; device: Device; screen: Screen; platform: Platform };

export type LaunchMode = "fresh" | "none";

/** What a fixture factory gets for one attempt (or, for `beforeAll`/`afterAll`, the idle session). */
export type FixtureContext = {
	session: Session;
	/** aborts at the attempt deadline; every driver call and poll must honour it */
	signal: AbortSignal;
	launch: LaunchMode;
	actionTimeoutMs: number;
	assertionTimeoutMs: number;
};

/**
 * Builds `app`/`device`/`screen`. Registered on `session.fixtures` or via `setDefaultFixtureFactory`.
 * The runner itself calls `app.open()` before the body when `launch` is `"fresh"`.
 */
export type FixtureFactory = (ctx: FixtureContext) => BaseFixtures | Promise<BaseFixtures>;

/** The running attempt: where steps, screenshots and failure files go. Read it through the session. */
export type AttemptContext = {
	readonly signal: AbortSignal;
	/** `<out>/<flowId>/<title-slug>-<hash6>/` */
	readonly dir: string;
	/** spec name tagging step lines */
	readonly short: string;
	readonly trace: TraceWriter;
	/** nesting depth of the step in progress (indents console lines) */
	depth: number;
	/** files written into `dir`, relative to it (reported in `TestResult.artifacts`) */
	readonly files: Set<string>;
	/** failures kept by `expect.soft`; the attempt fails with all of them once the body has settled */
	readonly softFailures: E2eError[];
};
