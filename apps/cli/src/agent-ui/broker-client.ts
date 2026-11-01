import { join } from "node:path";
import type { BrokerPort } from "@delacour/warden-sdk/ops/broker-port";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type {
	BrokerError,
	BrokerMethodName,
	BrokerMethods,
	BrokerRequest,
	BrokerResult,
	BrokerStatus,
	BuiltinRequest,
	ConsoleQuery,
	ExceptionsQuery,
	NetworkQuery,
	ResponseOf,
} from "../dev-broker/broker.types";
import type { CallOptions } from "../dev-broker/ipc";
import { type DevSessionRecord, findDevSession, listDevSessions } from "../dev-session";
import { type UiError, uiOutput } from "./output";

/**
 * The `warden dev` session's broker as `warden ui` and the MCP server see it. Kept light on purpose (no zod, no
 * e2e package): every devtools verb loads it. The socket client (`dev-broker/ipc.ts`) is imported on the first call.
 */

type Env = Record<string, string | undefined>;

export type BrokerCall = <R extends BrokerRequest>(
	socketPath: string,
	request: R,
	options?: CallOptions
) => Promise<BrokerResult<ResponseOf<R>>>;

/** Side effects of finding and calling a broker; tests replace them. */
export type BrokerClientDeps = {
	/** pid liveness for the session registry (default: a signal-0 probe) */
	isAlive?: (pid: number) => boolean;
	/** one request to a socket (default: `callBroker`) */
	call?: BrokerCall;
};

const START_HINT = "start `warden dev`";
/** a running session starts without a broker (`warden dev --devtools` or this turns it on) */
const ENABLE_HINT = "`warden dev enable devtools`";
/** how long `brokerFor` waits for `status` before treating the session as having no broker */
const PROBE_TIMEOUT_MS = 500;
/** a network entry lookup by id reads the whole ring (1 000 by default) */
const NETWORK_RING = 1000;

/** A live broker: `call` is typed per method. */
export type BrokerHandle = {
	session: DevSessionRecord;
	socketPath: string;
	call<M extends BrokerMethodName>(
		method: M,
		params: BrokerMethods[M]["params"],
		options?: CallOptions
	): Promise<BrokerResult<BrokerMethods[M]["data"]>>;
};

/** Which broker a work function talks to: an already-resolved `handle`, else the session of `udid` (or the only one). */
export type BrokerTarget = { env: Env; udid?: string; handle?: BrokerHandle };

/** Console or exception lines, with the jsonl the broker mirrors them to. */
export type LinesResult = { file: string; total: number; lines: BrokerMethods["console.query"]["data"]["lines"] };

/** Network entries, with the jsonl the broker mirrors them to. */
export type EntriesResult = { file: string; total: number; entries: BrokerMethods["network.query"]["data"]["entries"] };

export const CONSOLE_JSONL = "console.jsonl";
export const NETWORK_JSONL = "network.jsonl";

export type TreeParams = BrokerMethods["tree"]["params"] & {
	/** keep the first n components */
	max?: number;
	/** multiply rects by this (Android reports dp; default 1) */
	pixelRatio?: number;
};

export type TreeResult = BrokerMethods["tree"]["data"];

/** The session record beside the broker's own status. */
export type DevtoolsStatus = BrokerStatus & {
	session: Pick<
		DevSessionRecord,
		"leaseId" | "pid" | "platform" | "deviceId" | "metroUrl" | "logDir" | "projectRoot"
	> & {
		brokerSocket: string;
	};
};

const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;

const SINCE_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export class UiBrokerClient {
	private readonly lazyCall: BrokerCall = async (socketPath, request, options) => {
		const { devBrokerIpc } = await import("../dev-broker/ipc");
		return devBrokerIpc.callBroker(socketPath, request, options);
	};

	private handleOf(session: DevSessionRecord, socketPath: string, call: BrokerCall): BrokerHandle {
		return {
			session,
			socketPath,
			call: async (method, params, options) => {
				const request = { method, params } as BuiltinRequest;
				return (await call(socketPath, request, options)) as BrokerResult<BrokerMethods[typeof method]["data"]>;
			},
		};
	}

	/** The handle for `session` when its broker answers `status`, else undefined. */
	private async probe(session: DevSessionRecord, deps: BrokerClientDeps): Promise<BrokerHandle | undefined> {
		if (session.brokerSocket === undefined) return undefined;
		const handle = this.handleOf(session, session.brokerSocket, deps.call ?? this.lazyCall);
		const status = await handle.call("status", {}, { timeoutMs: PROBE_TIMEOUT_MS });
		return status.success ? handle : undefined;
	}

	private sessionDeps(deps: BrokerClientDeps) {
		return deps.isAlive === undefined ? undefined : { isAlive: deps.isAlive };
	}

	/**
	 * The broker of the live `warden dev` session on device `udid`, only when the session recorded a socket and the
	 * socket answers `status`. Undefined = no broker; callers fall back to their direct connection.
	 */
	async brokerFor(env: Env, udid: string, deps: BrokerClientDeps = {}): Promise<BrokerHandle | undefined> {
		const found = findDevSession(env, { udid }, this.sessionDeps(deps));
		return found.success ? this.probe(found.data, deps) : undefined;
	}

	/** A broker failure as a `warden ui` error. Unreachable / unavailable ones are `devtools_unavailable` (exit 3). */
	brokerUiError(error: BrokerError): UiError {
		const unreachable =
			error.code === "devtools_unavailable" || error.code === "device_mismatch" || error.code === "broker_unreachable";
		const details = { broker: error.code };
		if (unreachable)
			return uiOutput.uiError("devtools_unavailable", error.message, { hint: error.hint ?? START_HINT, details });
		return uiOutput.uiError(
			"failed",
			error.code === "eval_failed" ? error.message : `${error.code}: ${error.message}`,
			{
				...(error.hint === undefined ? {} : { hint: error.hint }),
				details,
			}
		);
	}

	/** True when `error` says the broker socket vanished mid-call (the caller may fall back to a direct connection). */
	brokerGone(error: UiError): boolean {
		return error.details?.broker === "broker_unreachable";
	}

	/** The broker for `target`: its handle, the session of `udid`, or the only live one (several: an error listing them). */
	async resolveBroker(target: BrokerTarget, deps: BrokerClientDeps = {}): Promise<Result<BrokerHandle, UiError>> {
		if (target.handle !== undefined) return resultFactory.ok(target.handle);
		const found = findDevSession(
			target.env,
			target.udid === undefined ? {} : { udid: target.udid },
			this.sessionDeps(deps)
		);
		if (!found.success) {
			const { code, message, hint } = found.error;
			if (code === "ambiguous_dev_session") {
				return {
					success: false,
					error: uiOutput.uiError("ambiguous_device", message, { hint: hint ?? "pass a udid" }),
				};
			}
			const gone = code === "no_dev_session";
			return {
				success: false,
				error: uiOutput.uiError(gone ? "devtools_unavailable" : "failed", message, {
					hint: gone ? START_HINT : (hint ?? START_HINT),
					details: { reason: code },
				}),
			};
		}
		const handle = await this.probe(found.data, deps);
		if (handle === undefined) {
			return {
				success: false,
				error: uiOutput.uiError(
					"devtools_unavailable",
					`the dev session on ${found.data.deviceId} has no broker answering`,
					{
						hint: ENABLE_HINT,
						details: { reason: "broker_unreachable" },
					}
				),
			};
		}
		return resultFactory.ok(handle);
	}

	private async viaBroker<T>(
		target: BrokerTarget,
		deps: BrokerClientDeps,
		run: (handle: BrokerHandle) => Promise<BrokerResult<T>>
	): Promise<Result<T, UiError>> {
		const handle = await this.resolveBroker(target, deps);
		if (!handle.success) return handle;
		const result = await run(handle.data);
		return result.success ? result : { success: false, error: this.brokerUiError(result.error) };
	}

	/** The app's console lines matching `params` (`since` is epoch ms). */
	queryConsole(
		target: BrokerTarget,
		params: ConsoleQuery,
		deps: BrokerClientDeps = {}
	): Promise<Result<LinesResult, UiError>> {
		return this.viaBroker(target, deps, async (handle) => {
			const reply = await handle.call("console.query", params);
			return reply.success
				? resultFactory.ok({
						file: join(handle.session.logDir, CONSOLE_JSONL),
						total: reply.data.total,
						lines: reply.data.lines,
					})
				: reply;
		});
	}

	/** The app's uncaught exceptions. */
	queryExceptions(
		target: BrokerTarget,
		params: ExceptionsQuery,
		deps: BrokerClientDeps = {}
	): Promise<Result<LinesResult, UiError>> {
		return this.viaBroker(target, deps, async (handle) => {
			const reply = await handle.call("exceptions.query", params);
			return reply.success
				? resultFactory.ok({
						file: join(handle.session.logDir, CONSOLE_JSONL),
						total: reply.data.total,
						lines: reply.data.lines,
					})
				: reply;
		});
	}

	/** The app's recorded `fetch` calls matching `params`. */
	queryNetwork(
		target: BrokerTarget,
		params: NetworkQuery,
		deps: BrokerClientDeps = {}
	): Promise<Result<EntriesResult, UiError>> {
		return this.viaBroker(target, deps, async (handle) => {
			const reply = await handle.call("network.query", params);
			return reply.success
				? resultFactory.ok({
						file: join(handle.session.logDir, NETWORK_JSONL),
						total: reply.data.total,
						entries: reply.data.entries,
					})
				: reply;
		});
	}

	/** One recorded `fetch` call by id, searching the broker's whole ring; undefined when it is not there. */
	networkEntryById(
		target: BrokerTarget,
		id: number,
		deps: BrokerClientDeps = {}
	): Promise<Result<EntriesResult["entries"][number] | undefined, UiError>> {
		return this.viaBroker(target, deps, async (handle) => {
			const reply = await handle.call("network.query", { limit: NETWORK_RING });
			return reply.success ? resultFactory.ok(reply.data.entries.find((entry) => entry.id === id)) : reply;
		});
	}

	/** Run JavaScript in the app. `undefined` comes back as `null`. */
	evalExpr(
		target: BrokerTarget,
		params: { expression: string; timeoutMs?: number },
		deps: BrokerClientDeps = {}
	): Promise<Result<{ value: unknown }, UiError>> {
		return this.viaBroker(target, deps, (handle) => handle.call("eval", params));
	}

	private scale(value: number, ratio: number): number {
		return Math.round(value * ratio * 10) / 10;
	}

	/** The app's React components (`depth` / `testID` cut by the broker, `max` / `pixelRatio` applied here). */
	readTree(
		target: BrokerTarget,
		params: TreeParams = {},
		deps: BrokerClientDeps = {}
	): Promise<Result<TreeResult, UiError>> {
		const { max, pixelRatio, ...query } = params;
		return this.viaBroker(target, deps, async (handle) => {
			const reply = await handle.call("tree", query);
			if (!reply.success) return reply;
			const ratio = pixelRatio ?? 1;
			if (max === undefined && ratio === 1) return reply;
			const cut = max !== undefined && reply.data.components.length > max;
			const components = (cut ? reply.data.components.slice(0, max) : reply.data.components).map((component) =>
				component.rect === undefined || ratio === 1
					? component
					: {
							...component,
							rect: {
								x: this.scale(component.rect.x, ratio),
								y: this.scale(component.rect.y, ratio),
								width: this.scale(component.rect.width, ratio),
								height: this.scale(component.rect.height, ratio),
							},
						}
			);
			const { treeFormatter } = await import("@delacour/warden-devtools/tree");
			const tree = {
				...(reply.data.screen === undefined ? {} : { screen: reply.data.screen }),
				components,
				truncated: reply.data.truncated || cut,
			};
			return resultFactory.ok({ ...tree, lines: treeFormatter.format(tree) });
		});
	}

	/** The route key of the screen the app is on, or null. */
	readRoute(target: BrokerTarget, deps: BrokerClientDeps = {}): Promise<Result<{ route: string | null }, UiError>> {
		return this.viaBroker(target, deps, (handle) => handle.call("route", {}));
	}

	/** Reload the app's JavaScript. */
	reloadApp(
		target: BrokerTarget,
		deps: BrokerClientDeps = {}
	): Promise<Result<BrokerMethods["reload"]["data"], UiError>> {
		return this.viaBroker(target, deps, (handle) => handle.call("reload", {}));
	}

	/** What the dev session's broker is doing: attached, yielded to Chrome DevTools, lost, ... */
	devtoolsStatus(target: BrokerTarget, deps: BrokerClientDeps = {}): Promise<Result<DevtoolsStatus, UiError>> {
		return this.viaBroker(target, deps, async (handle) => {
			const reply = await handle.call("status", {});
			if (!reply.success) return reply;
			const { leaseId, pid, platform, deviceId, metroUrl, logDir, projectRoot } = handle.session;
			return resultFactory.ok({
				...reply.data,
				session: { leaseId, pid, platform, deviceId, metroUrl, logDir, projectRoot, brokerSocket: handle.socketPath },
			});
		});
	}

	/** Take the page back after the broker yielded to another debugger (this kicks that debugger on a single-debugger Metro). */
	devtoolsResume(
		target: BrokerTarget,
		deps: BrokerClientDeps = {}
	): Promise<Result<BrokerMethods["resume"]["data"], UiError>> {
		return this.viaBroker(target, deps, (handle) => handle.call("resume", {}));
	}

	/** Every live dev session that has a broker socket (for "which one?" messages). */
	brokerSessions(env: Env, deps: BrokerClientDeps = {}): DevSessionRecord[] {
		const listed = listDevSessions(env, this.sessionDeps(deps));
		return listed.success ? listed.data.filter((s) => s.brokerSocket !== undefined) : [];
	}

	/** `--since`: a duration back from now (`30s`, `5m`, `2h`, `1d`, `250ms`) or an ISO time, as epoch ms. */
	parseSince(raw: string, now: number): Result<number, UiError> {
		const duration = /^(\d+)(ms|s|m|h|d)$/.exec(raw);
		if (duration !== null) return resultFactory.ok(now - Number(duration[1]) * (SINCE_UNITS[duration[2] ?? "ms"] ?? 1));
		const at = Date.parse(raw);
		if (Number.isNaN(at)) {
			return {
				success: false,
				error: uiOutput.uiError("usage", `--since must be a duration (30s, 5m, 2h) or an ISO time, got "${raw}"`),
			};
		}
		return resultFactory.ok(at);
	}

	/** Undefined = no broker answers (or it vanished mid-call): the SDK op goes direct to Metro; other failures are the op's error. */
	private viaPort<T>(result: Result<T, UiError>): Result<T, UiError> | undefined {
		return !result.success && (this.brokerGone(result.error) || result.error.details?.reason === "no_dev_session")
			? undefined
			: result;
	}

	/**
	 * The SDK devtools ops' {@link BrokerPort} over the dev-session registry and the broker socket of device `udid`.
	 * `deps` replace pid liveness and the socket call (tests).
	 */
	brokerPortFor(env: Env, udid: string, deps: BrokerClientDeps = {}): BrokerPort {
		const target: BrokerTarget = { env, udid };
		const direct = async <T>(run: Promise<Result<T, UiError>>) => this.viaPort(await run);
		const needed = async <T>(run: Promise<Result<T, UiError>>): Promise<Result<T, UiError>> => run;
		return {
			available: async () => (await this.brokerFor(env, udid, deps)) !== undefined,
			logDir: async () => (await this.brokerFor(env, udid, deps))?.session.logDir,
			eval: ({ expression, timeoutMs }) => direct(this.evalExpr(target, { expression, timeoutMs }, deps)),
			tree: ({ max, pixelRatio }) =>
				direct(this.readTree(target, { ...(max === undefined ? {} : { max }), pixelRatio }, deps)),
			reload: () => direct(this.reloadApp(target, deps)),
			console: ({ level, ...query }) => {
				const known = CONSOLE_LEVELS.find((candidate) => candidate === level);
				return direct(this.queryConsole(target, { ...query, ...(known === undefined ? {} : { level: known }) }, deps));
			},
			exceptions: (query) => direct(this.queryExceptions(target, query, deps)),
			network: ({ urlGrep, ...query }) =>
				direct(this.queryNetwork(target, { ...query, ...(urlGrep === undefined ? {} : { urlGrep }) }, deps)),
			networkEntry: (id) => direct(this.networkEntryById(target, id, deps)),
			route: () => direct(this.readRoute(target, deps)),
			status: () => needed(this.devtoolsStatus(target, deps)),
			resume: () => needed(this.devtoolsResume(target, deps)),
		};
	}
}

export const uiBrokerClient = new UiBrokerClient();
