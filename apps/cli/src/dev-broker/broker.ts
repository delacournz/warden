import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CloseInfo } from "@delacour/warden-e2e/devtools/cdp";
import { type ConsoleCapture, createConsoleCapture } from "@delacour/warden-e2e/devtools/console";
import type {
	ConsoleLevel,
	ConsoleLine,
	Fetch,
	NetworkEntry,
	Sleep,
} from "@delacour/warden-e2e/devtools/devtools.types";
import { appendJsonl, writeJsonl } from "@delacour/warden-e2e/devtools/jsonl";
import { attachNetwork, type NetworkCapture } from "@delacour/warden-e2e/devtools/network";
import { readRoute } from "@delacour/warden-e2e/devtools/route";
import {
	type ConnectDevtoolsOptions,
	connectDevtools,
	type DevtoolsDevice,
	type DevtoolsSession,
} from "@delacour/warden-e2e/devtools/session";
import { fetchTree, formatTree } from "@delacour/warden-e2e/devtools/tree";
import { ok } from "@delacour/warden-types/result";
import {
	consoleQuerySchema,
	evalParamsSchema,
	exceptionsQuerySchema,
	networkQuerySchema,
	noParamsSchema,
	treeParamsSchema,
} from "./broker.schema";
import {
	type BrokerContext,
	type BrokerMethodName,
	type BrokerMethods,
	type BrokerResult,
	type BrokerState,
	type BrokerStatus,
	brokerErr,
	type LineProcessor,
	type MethodHandler,
	type NetworkQuery,
} from "./broker.types";
import { isAppException } from "./exceptions";
import { type BrokerServer, chooseSocketPath, serveBroker } from "./ipc";
import { filterTree } from "./tree-filter";

export type {
	BrokerError,
	BrokerMethods,
	BrokerRequest,
	BrokerResult,
	BrokerState,
	BrokerStatus,
	LineProcessor,
	MethodHandler,
	ResponseOf,
} from "./broker.types";
export { type CallOptions, callBroker, chooseSocketPath } from "./ipc";

const DEFAULT_CONSOLE_RING = 5_000;
const DEFAULT_NETWORK_RING = 1_000;
const DEFAULT_LIMIT = 200;
const DEFAULT_EVAL_TIMEOUT_MS = 10_000;
const DEFAULT_NETWORK_POLL_MS = 500;
const DEFAULT_RETRY: Backoff = { initialMs: 500, maxMs: 5_000 };
const CONSOLE_FILE = "console.jsonl";
const NETWORK_FILE = "network.jsonl";

/**
 * Metro's inspector proxy closes the older debugger with this tag in the close reason when a second one opens on
 * a page that does not advertise `supportsMultipleDebuggers` (see `Device.js` `WS_CLOSE_REASON`).
 */
export const NEW_DEBUGGER_TAG = "[NEW_DEBUGGER_OPENED]";

const SEVERITY: Record<ConsoleLevel, number> = { debug: 0, log: 1, info: 2, warn: 3, error: 4 };

const timerSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export type Backoff = { initialMs: number; maxMs: number };

export type BrokerOptions = {
	metroUrl: string;
	/** pin the page: `logicalDeviceId` on a Metro shared by several devices, `deviceName`, `appId` */
	device: DevtoolsDevice;
	/** gets `console.jsonl`, `network.jsonl` and (when it fits) `broker.sock` */
	logDir: string;
	/** console lines kept (default 5000) */
	consoleRing?: number;
	/** network entries kept (default 1000) */
	networkRing?: number;
	includeBodies?: boolean;
	log?: (line: string) => void;
	/** called with every state change, the first `connecting` included */
	onState?: (state: BrokerState) => void;
	/** pause between attach attempts while there is no page (default 500 ms, doubling to 5 s) */
	retry?: Backoff;
	/**
	 * After a takeover, try to take the page back on this schedule. Off by default: on a Metro that allows one
	 * debugger per page the attempt itself kicks the other debugger, and Metro does not say when it has left, so
	 * the broker waits for `resume`.
	 */
	yieldRetry?: Backoff;
	networkPollMs?: number;
	/** overrides `<logDir>/broker.sock` (and the short fallback) */
	socketPath?: string;
	connect?: typeof connectDevtools;
	fetch?: Fetch;
	WebSocket?: typeof WebSocket;
	sleep?: Sleep;
	now?: () => number;
	pid?: number;
};

export type Broker = {
	/** the socket actually bound (a short temp path when `<logDir>/broker.sock` is too long) */
	socketPath: string;
	state(): BrokerState;
	/** Leave `yielded` now and take the page back. A no-op in any other state. */
	resume(): void;
	/**
	 * Answer `name` with `handler`; fails for a built-in or an already registered name. For `logpoint.*` and
	 * `profile.*`. The returned function unregisters it.
	 */
	registerMethod(name: string, handler: MethodHandler): BrokerResult<() => void>;
	/** Rewrite lines on their way out of `console.query` / `exceptions.query` (symbolication). Returns its remover. */
	addLineProcessor(processor: LineProcessor): () => void;
	/** Called with each session once attached (after a reconnect-by-restart too), e.g. to re-arm logpoints. */
	onAttach(handler: (session: DevtoolsSession) => void): () => void;
	close(): Promise<void>;
};

type SessionEnd = { kind: "lost"; error: string } | { kind: "yielded"; reason: string } | { kind: "closed" };

type Live = {
	session: DevtoolsSession;
	network: NetworkCapture;
	ended: Promise<SessionEnd>;
	/** ends `ended` from outside (the broker is closing) */
	finish: (end: SessionEnd) => void;
	offs: (() => void)[];
};

const BUILTIN_NAMES: readonly BrokerMethodName[] = [
	"status",
	"console.query",
	"exceptions.query",
	"network.query",
	"eval",
	"tree",
	"route",
	"reload",
	"resume",
];

const isBuiltin = (name: string): name is BrokerMethodName => (BUILTIN_NAMES as readonly string[]).includes(name);

function badParams(method: string, message: string) {
	return brokerErr("bad_request", `${method}: ${message}`);
}

/** The `since` / `limit` / text filters shared by both console queries. */
function newest<T>(rows: readonly T[], limit: number | undefined): T[] {
	const n = limit ?? DEFAULT_LIMIT;
	return rows.length > n ? rows.slice(rows.length - n) : [...rows];
}

function statusMatches(filter: NonNullable<NetworkQuery["status"]>, status: number): boolean {
	if (typeof filter === "number") return status === filter;
	return Math.floor(status / 100) === Number(filter.charAt(0));
}

/** Why there is no live session right now, and what to do about it. */
function unavailable(state: BrokerState): BrokerResult<never> {
	switch (state.phase) {
		case "yielded":
			return brokerErr(
				"devtools_unavailable",
				"another debugger (React Native DevTools) holds the app's page",
				"close that DevTools window, then run the `resume` method (or press the resume key in `warden dev`)"
			);
		case "connecting":
			return brokerErr(
				"devtools_unavailable",
				`not attached to the app yet${state.lastError ? ` (${state.lastError})` : ""}`,
				"launch the app on the dev client and wait for Metro to list its page"
			);
		case "lost":
			return brokerErr("devtools_unavailable", `the app's page went away (${state.error})`, "relaunch the app");
		default:
			return brokerErr("cdp_closed", "the dev session has ended");
	}
}

/**
 * Own the one CDP socket of a `warden dev` session. The broker attaches to the app through Metro, keeps the
 * console and network in ring buffers (and in `console.jsonl` / `network.jsonl`, same rows as `ui logs`), and
 * answers queries from other processes on a Unix socket (`callBroker`).
 *
 * It never fails the dev session: with no page yet it retries with backoff (`connecting`). If Metro's proxy
 * allows one debugger per page and another one opens, it is closed with {@link NEW_DEBUGGER_TAG}; the broker
 * then goes `yielded` and does not reconnect (that would kick the other debugger in turn) until `resume`.
 * On a proxy that allows several debuggers nothing of this triggers and the broker just stays attached.
 */
export async function startBroker(o: BrokerOptions): Promise<BrokerResult<Broker>> {
	const log = o.log ?? (() => undefined);
	const sleep = o.sleep ?? timerSleep;
	const now = o.now ?? Date.now;
	const connect = o.connect ?? connectDevtools;
	const retry = o.retry ?? DEFAULT_RETRY;
	const startedAt = now();
	const consolePath = join(o.logDir, CONSOLE_FILE);
	const networkPath = join(o.logDir, NETWORK_FILE);

	try {
		await mkdir(o.logDir, { recursive: true });
		await writeJsonl(consolePath, []);
		await writeJsonl(networkPath, []);
	} catch (error) {
		return brokerErr("io_failed", `cannot write to ${o.logDir}: ${String(error)}`);
	}

	let state: BrokerState = { phase: "connecting", attempt: 0 };
	let closed = false;
	let live: Live | undefined;
	let consoleTotal = 0;
	let networkTotal = 0;
	let networkRing: NetworkEntry[] = [];
	const networkRingSize = o.networkRing ?? DEFAULT_NETWORK_RING;
	let writes: Promise<unknown> = Promise.resolve();
	let pinnedLogicalId = o.device.logicalDeviceId;
	let wake: (() => void) | undefined;
	const methods = new Map<string, MethodHandler>();
	const processors = new Set<LineProcessor>();
	const attachHandlers = new Set<(session: DevtoolsSession) => void>();

	const append = (path: string, row: unknown) => {
		writes = writes
			.then(() => appendJsonl(path, [row]))
			.catch((error) => log(`broker: write failed: ${String(error)}`));
	};

	const consoleCapture: ConsoleCapture = createConsoleCapture({
		ring: o.consoleRing ?? DEFAULT_CONSOLE_RING,
		now,
		sink: (line) => {
			consoleTotal++;
			append(consolePath, line);
		},
	});

	const setState = (next: BrokerState) => {
		if (JSON.stringify(next) === JSON.stringify(state)) return;
		state = next;
		o.onState?.(next);
	};
	o.onState?.(state);

	/** Sleeps `ms` (forever when omitted), or less when `resume()` / `close()` wakes it. */
	const pause = (ms?: number): Promise<void> =>
		new Promise<void>((resolve) => {
			const done = () => {
				wake = undefined;
				resolve();
			};
			wake = done;
			if (ms !== undefined) void sleep(ms).then(done);
		});

	const onNetworkEntry = (entry: NetworkEntry) => {
		const row: NetworkEntry = { ...entry, id: ++networkTotal };
		networkRing.push(row);
		if (networkRing.length > networkRingSize) networkRing = networkRing.slice(networkRing.length - networkRingSize);
		append(networkPath, row);
	};

	const teardown = (current: Live) => {
		for (const off of current.offs) off();
		current.network.stop();
		current.session.close();
		if (live === current) live = undefined;
	};

	/** Connect, capture the network, and watch for the session ending. */
	async function attachOnce(): Promise<BrokerResult<Live>> {
		const device: DevtoolsDevice = { ...o.device, logicalDeviceId: pinnedLogicalId };
		const options: ConnectDevtoolsOptions = {
			metroUrl: o.metroUrl,
			device,
			fetch: o.fetch ?? fetch,
			WebSocket: o.WebSocket,
			log,
			sleep,
			taps: [consoleCapture.handle],
			yieldOnClose: (info: CloseInfo) => info.reason.includes(NEW_DEBUGGER_TAG),
		};
		const connected = await connect(options);
		if (!connected.success) return brokerErr(connected.error.code, connected.error.message);
		const session = connected.data;
		const network = await attachNetwork(session, {
			ring: networkRingSize,
			metroUrl: o.metroUrl,
			includeBodies: o.includeBodies,
			pollMs: o.networkPollMs ?? DEFAULT_NETWORK_POLL_MS,
			sink: onNetworkEntry,
		});
		if (!network.success) {
			session.close();
			return brokerErr(network.error.code, network.error.message);
		}
		const offs: (() => void)[] = [];
		let finish: Live["finish"] = () => undefined;
		const ended = new Promise<SessionEnd>((resolve) => {
			finish = resolve;
			offs.push(session.on("lost", (error) => resolve({ kind: "lost", error: error.message })));
			offs.push(
				session.on("yielded", (info) => resolve({ kind: "yielded", reason: `${info.code} ${info.reason}`.trim() }))
			);
			offs.push(
				session.on("reconnected", (target) => {
					pinnedLogicalId = target.logicalDeviceId ?? pinnedLogicalId;
					setState({ phase: "attached", targetId: target.id, deviceName: target.deviceName, appId: target.appId });
				})
			);
		});
		pinnedLogicalId = session.target.logicalDeviceId ?? pinnedLogicalId;
		return ok({ session, network: network.data, ended, finish, offs });
	}

	let yieldBackoffMs = o.yieldRetry?.initialMs ?? 0;

	/** Logs the first failure and any change of message, not every identical retry. */
	function logAttachFailure(attempt: number, message: string): void {
		const repeated = attempt > 1 && state.phase === "connecting" && state.lastError === message;
		if (!repeated) log(`devtools: attach attempt ${attempt} failed: ${message}`);
	}

	/** Attach, backing off between failed attempts; `undefined` once the broker is closed. */
	async function attachWithRetry(): Promise<Live | undefined> {
		let attempt = 0;
		let backoffMs = retry.initialMs;
		while (!closed) {
			const attached = await attachOnce();
			if (closed) {
				if (attached.success) teardown(attached.data);
				return undefined;
			}
			if (attached.success) return attached.data;
			attempt++;
			logAttachFailure(attempt, attached.error.message);
			setState({ phase: "connecting", attempt, lastError: attached.error.message });
			await pause(backoffMs);
			backoffMs = Math.min(retry.maxMs, backoffMs * 2);
		}
		return undefined;
	}

	/** What follows a session that ended: a short pause after a loss, the wait for `resume` after a takeover. */
	async function afterEnd(end: Exclude<SessionEnd, { kind: "closed" }>): Promise<void> {
		if (end.kind === "lost") {
			log(`devtools: lost (${end.error}), retrying`);
			setState({ phase: "lost", error: end.error });
			await pause(retry.initialMs);
			return;
		}
		log("devtools: yielded to another debugger");
		setState({ phase: "yielded", reason: end.reason });
		if (o.yieldRetry) {
			await pause(yieldBackoffMs);
			yieldBackoffMs = Math.min(o.yieldRetry.maxMs, yieldBackoffMs * 2);
		} else {
			await pause();
		}
		if (closed) return;
		log("devtools: taking the page back");
		setState({ phase: "connecting", attempt: 0 });
	}

	/** attach → wait for the session to end → pause or wait for `resume`, until closed */
	async function supervise(): Promise<void> {
		for (;;) {
			const current = await attachWithRetry();
			if (!current) return;
			live = current;
			const target = current.session.target;
			setState({ phase: "attached", targetId: target.id, deviceName: target.deviceName, appId: target.appId });
			for (const handler of [...attachHandlers]) handler(current.session);
			const end = await current.ended;
			teardown(current);
			if (end.kind === "closed" || closed) return;
			await afterEnd(end);
		}
	}

	const context: BrokerContext = {
		state: () => state,
		requireSession: () => (live && state.phase === "attached" ? ok(live.session) : unavailable(state)),
		metroUrl: o.metroUrl,
		now,
	};

	const processLines = async (lines: ConsoleLine[]): Promise<ConsoleLine[]> => {
		let out = lines;
		for (const processor of [...processors]) out = await Promise.all(out.map((line) => processor(line)));
		return out;
	};

	const queryLines = async (
		lines: readonly ConsoleLine[],
		query: { since?: number; level?: ConsoleLevel; grep?: string; limit?: number; kind?: ConsoleLine["kind"] }
	) => {
		const grep = query.grep?.toLowerCase();
		const minimum = query.level === undefined ? undefined : SEVERITY[query.level];
		const matched = lines.filter(
			(line) =>
				(query.since === undefined || line.ts >= query.since) &&
				(query.kind === undefined || line.kind === query.kind) &&
				(minimum === undefined || SEVERITY[line.level] >= minimum) &&
				(grep === undefined || line.text.toLowerCase().includes(grep))
		);
		return { lines: await processLines(newest(matched, query.limit)), total: matched.length };
	};

	const status = (): BrokerStatus => ({
		state,
		pid: o.pid ?? process.pid,
		metroUrl: o.metroUrl,
		logDir: o.logDir,
		startedAt,
		console: { buffered: consoleCapture.lines().length, total: consoleTotal },
		network: { buffered: networkRing.length, total: networkTotal },
		methods: [...BUILTIN_NAMES, ...methods.keys()],
	});

	type Handlers = { [M in BrokerMethodName]: (params: unknown) => Promise<BrokerResult<BrokerMethods[M]["data"]>> };

	const handlers: Handlers = {
		async status(params) {
			const parsed = noParamsSchema.safeParse(params ?? {});
			if (!parsed.success) return badParams("status", parsed.error.message);
			return ok(status());
		},
		async "console.query"(params) {
			const parsed = consoleQuerySchema.safeParse(params ?? {});
			if (!parsed.success) return badParams("console.query", parsed.error.message);
			return ok(await queryLines(consoleCapture.lines(), parsed.data));
		},
		async "exceptions.query"(params) {
			const parsed = exceptionsQuerySchema.safeParse(params ?? {});
			if (!parsed.success) return badParams("exceptions.query", parsed.error.message);
			return ok(await queryLines(consoleCapture.lines().filter(isAppException), parsed.data));
		},
		async "network.query"(params) {
			const parsed = networkQuerySchema.safeParse(params ?? {});
			if (!parsed.success) return badParams("network.query", parsed.error.message);
			const { since, urlGrep, status: wanted, limit } = parsed.data;
			// drain the page first so the newest requests are in; a yielded broker answers from what it has
			await live?.network.entries({ id: 0 });
			const grep = urlGrep?.toLowerCase();
			const matched = networkRing.filter(
				(entry) =>
					(since === undefined || entry.ts >= since) &&
					(grep === undefined || entry.url.toLowerCase().includes(grep)) &&
					(wanted === undefined || statusMatches(wanted, entry.status))
			);
			return ok({ entries: newest(matched, limit), total: matched.length });
		},
		async eval(params) {
			const parsed = evalParamsSchema.safeParse(params);
			if (!parsed.success) return badParams("eval", parsed.error.message);
			const session = context.requireSession();
			if (!session.success) return session;
			const result = await session.data.evaluate(parsed.data.expression, {
				await: true,
				timeoutMs: parsed.data.timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS,
			});
			if (!result.success) return brokerErr(result.error.code ?? "eval_failed", result.error.message);
			return ok({ value: result.data ?? null });
		},
		async tree(params) {
			const parsed = treeParamsSchema.safeParse(params ?? {});
			if (!parsed.success) return badParams("tree", parsed.error.message);
			const session = context.requireSession();
			if (!session.success) return session;
			const fetched = await fetchTree(session.data, {}, { sleep });
			if (!fetched.success) return brokerErr(fetched.error.code, fetched.error.message);
			const tree = filterTree(fetched.data, parsed.data);
			return ok({
				...(tree.screen === undefined ? {} : { screen: tree.screen }),
				lines: formatTree(tree),
				components: tree.components,
				truncated: tree.truncated,
			});
		},
		async route(params) {
			const parsed = noParamsSchema.safeParse(params ?? {});
			if (!parsed.success) return badParams("route", parsed.error.message);
			const session = context.requireSession();
			if (!session.success) return session;
			const route = await readRoute(session.data);
			if (!route.success) return brokerErr(route.error.code, route.error.message);
			return ok({ route: route.data ?? null });
		},
		async reload(params) {
			const parsed = noParamsSchema.safeParse(params ?? {});
			if (!parsed.success) return badParams("reload", parsed.error.message);
			const session = context.requireSession();
			if (!session.success) return session;
			const reloaded = await session.data.reloadJs();
			if (!reloaded.success) return brokerErr(reloaded.error.code, reloaded.error.message);
			return ok(reloaded.data);
		},
		async resume(params) {
			const parsed = noParamsSchema.safeParse(params ?? {});
			if (!parsed.success) return badParams("resume", parsed.error.message);
			broker.resume();
			return ok({ state });
		},
	};

	const dispatch = async (method: string, params: unknown): Promise<BrokerResult<unknown>> => {
		if (isBuiltin(method)) return handlers[method](params);
		const registered = methods.get(method);
		if (registered) return registered(params, context);
		return brokerErr("unknown_method", `unknown method ${method}`, `known: ${status().methods.join(", ")}`);
	};

	const socketPath = o.socketPath ?? chooseSocketPath(o.logDir);
	const served = await serveBroker(socketPath, dispatch);
	if (!served.success) return served;
	const server: BrokerServer = served.data;

	const broker: Broker = {
		socketPath: server.socketPath,
		state: () => state,
		resume() {
			if (state.phase === "yielded") wake?.();
		},
		registerMethod(name, handler) {
			if (isBuiltin(name) || methods.has(name)) {
				return brokerErr("bad_request", `method ${name} is already registered`);
			}
			methods.set(name, handler);
			return ok(() => {
				methods.delete(name);
			});
		},
		addLineProcessor(processor) {
			processors.add(processor);
			return () => {
				processors.delete(processor);
			};
		},
		onAttach(handler) {
			attachHandlers.add(handler);
			if (live) handler(live.session);
			return () => {
				attachHandlers.delete(handler);
			};
		},
		async close() {
			if (closed) return;
			closed = true;
			setState({ phase: "closed" });
			wake?.();
			if (live) {
				live.finish({ kind: "closed" });
				teardown(live);
			}
			await server.close();
			await writes;
		},
	};

	void supervise();
	return ok(broker);
}
