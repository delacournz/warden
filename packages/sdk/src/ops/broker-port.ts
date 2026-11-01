import type { ConsoleLine, NetworkEntry, TreeComponent } from "@delacour/warden-devtools/devtools.types";
import type { WardenError } from "@delacour/warden-types/error";
import type { Result } from "@delacour/warden-types/result";

/** A query over console or exception lines; `since` is epoch ms. */
export type LineQuery = {
	limit: number;
	since?: number;
	level?: string;
	grep?: string;
	kind?: "note" | "exception" | "console";
};

/** A query over recorded `fetch` calls; `status` is a code (404) or a class ("4xx"). */
export type EntryQuery = { limit: number; since?: number; urlGrep?: string; status?: number | string };

export type BrokerLines = { file: string; total: number; lines: ConsoleLine[] };
export type BrokerEntries = { file: string; total: number; entries: NetworkEntry[] };
export type BrokerTree = { screen?: string; lines: string[]; components: TreeComponent[]; truncated: boolean };

/** Where the dev session's broker is (attached, yielded to Chrome DevTools, lost, ...). */
export type BrokerStateView = { phase: string; [detail: string]: unknown };

export type BrokerStatusView = {
	state: BrokerStateView;
	pid: number;
	metroUrl: string;
	logDir: string;
	console: { buffered: number; total: number };
	network: { buffered: number; total: number };
	methods: string[];
	session: { leaseId: string; pid: number; platform: string; deviceId: string; metroUrl: string; logDir: string };
};

/** One broker call: `undefined` = no broker answers (or it vanished mid-call), so the op goes direct to Metro. */
type Via<T> = Promise<Result<T, WardenError> | undefined>;

/**
 * The `warden dev` session's devtools broker as the devtools ops see it. The CLI implements it over the session
 * registry and the broker socket; ops try it first (unless a Metro was named) and fall back to a direct connection.
 */
export type BrokerPort = {
	/** whether a broker answers for this device now */
	available: () => Promise<boolean>;
	/** the dir the broker mirrors console and network to (when one answers) */
	logDir: () => Promise<string | undefined>;
	eval: (params: { expression: string; timeoutMs: number }) => Via<{ value: unknown }>;
	tree: (params: { max?: number; pixelRatio: number }) => Via<BrokerTree>;
	reload: () => Via<{ method: "expo" | "devsettings" | "http" }>;
	console: (query: LineQuery) => Via<BrokerLines>;
	exceptions: (query: Pick<LineQuery, "limit" | "since">) => Via<BrokerLines>;
	network: (query: EntryQuery) => Via<BrokerEntries>;
	networkEntry: (id: number) => Via<NetworkEntry | undefined>;
	route: () => Via<{ route: string | null }>;
	/** these two need a broker: no dev session is an error, not a fall back */
	status: () => Promise<Result<BrokerStatusView, WardenError>>;
	resume: () => Promise<Result<{ state: BrokerStateView }, WardenError>>;
};
