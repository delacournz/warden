import { type DevSessionDeps, type DevSessionError, findDevSession } from "../dev-session";
import type { BrokerError, BrokerResult } from "./broker.types";

export type ProfileKind = "cpu" | "heap" | "react";

export type ProfileFn = { name: string; file: string; line: number };

/** What `profile.stop` says about the artifact: the few rows an agent reads first. The full data is at `path`. */
export type ProfileSummary =
	| {
			kind: "cpu";
			sampleCount: number;
			durationMs: number;
			idlePct: number;
			/** `hotspots.json` beside the `.cpuprofile` */
			hotspotsPath: string;
			topSelf: Array<ProfileFn & { selfMs: number; selfPct: number }>;
	  }
	| {
			kind: "heap";
			totalBytes: number;
			/** allocation sites by bytes still live at the end of the sampling */
			topAllocators: Array<ProfileFn & { selfBytes: number; pct: number }>;
	  }
	| {
			kind: "react";
			commits: number;
			renderMs: number;
			hotCommits: number;
			/** `findings.json` beside `commits.json` */
			findingsPath: string;
			slowestCommits: Array<{ index: number; durationMs: number; tier: string; top: string[] }>;
			slowestComponents: Array<{ name: string; sumSelfMs: number; commits: number; where?: string }>;
	  };

export type ProfileStartParams = {
	kind: ProfileKind;
	/** CPU sampling period in microseconds (default 100); ignored for heap and React */
	samplingIntervalUs?: number;
};
export type ProfileStartData = { kind: ProfileKind; startedAt: number };

export type ProfileStopParams = { kind: ProfileKind };
/** `path` = `.cpuprofile` / `.heapsampling` / `commits.json` under `<logDir>/profiles/` */
export type ProfileStopData = { kind: ProfileKind; path: string; summary: ProfileSummary };

export type ProfileStatusData = { active: Array<{ kind: ProfileKind; startedAt: number }> };

type Env = Record<string, string | undefined>;

/** `call` and the session lookup are injected: tests use a fake broker, the MCP server a real socket. */
export type ProfileClientDeps = {
	call: (socketPath: string, request: { method: string; params?: unknown }) => Promise<BrokerResult<unknown>>;
	sessions?: DevSessionDeps;
};

const defaultDeps: ProfileClientDeps = {
	call: async (socketPath, request) => (await import("./ipc")).callBroker(socketPath, request),
};

export type ProfileClientQuery = { udid?: string };

function lookupError(error: DevSessionError): BrokerError {
	return {
		code: "broker_unreachable",
		message: error.message,
		...(error.hint === undefined ? {} : { hint: error.hint }),
	};
}

/** The broker socket of the dev session for `udid` (the only live one when omitted). */
export function brokerSocketFor(
	env: Env,
	query: ProfileClientQuery,
	deps: ProfileClientDeps = defaultDeps
): BrokerResult<string> {
	const found = findDevSession(env, query.udid === undefined ? {} : { udid: query.udid }, deps.sessions);
	if (!found.success) return { success: false, error: lookupError(found.error) };
	const socket = found.data.brokerSocket;
	if (socket === undefined) {
		return {
			success: false,
			error: {
				code: "broker_unreachable",
				message: `dev session ${found.data.deviceId} has no devtools broker`,
				hint: "restart `warden dev`",
			},
		};
	}
	return { success: true, data: socket };
}

async function callProfile<T>(
	env: Env,
	query: ProfileClientQuery,
	request: { method: string; params?: unknown },
	deps: ProfileClientDeps
): Promise<BrokerResult<T>> {
	const socket = brokerSocketFor(env, query, deps);
	if (!socket.success) return socket;
	const reply = await deps.call(socket.data, request);
	return reply.success ? { success: true, data: reply.data as T } : reply;
}

/** `profile.start` on the dev session's broker (MCP `profile_start`, `warden perf js`). */
export function startProfile(
	env: Env,
	params: ProfileClientQuery & ProfileStartParams,
	deps: ProfileClientDeps = defaultDeps
): Promise<BrokerResult<ProfileStartData>> {
	const { udid, ...rest } = params;
	return callProfile(env, { ...(udid === undefined ? {} : { udid }) }, { method: "profile.start", params: rest }, deps);
}

/** `profile.stop`: writes the artifact under the session log dir and returns its path and a summary. */
export function stopProfile(
	env: Env,
	params: ProfileClientQuery & ProfileStopParams,
	deps: ProfileClientDeps = defaultDeps
): Promise<BrokerResult<ProfileStopData>> {
	const { udid, kind } = params;
	return callProfile(
		env,
		{ ...(udid === undefined ? {} : { udid }) },
		{ method: "profile.stop", params: { kind } },
		deps
	);
}

/** `profile.status`: which captures the broker is recording. */
export function profileStatus(
	env: Env,
	params: ProfileClientQuery = {},
	deps: ProfileClientDeps = defaultDeps
): Promise<BrokerResult<ProfileStatusData>> {
	return callProfile(env, params, { method: "profile.status", params: {} }, deps);
}

/**
 * Ask the dev session's broker (if any) to take the page back after another process used the single debugger slot.
 * Best-effort: no session, no broker or a failed call all resolve to `false`.
 */
export async function resumeBroker(
	env: Env,
	query: ProfileClientQuery,
	deps: ProfileClientDeps = defaultDeps
): Promise<boolean> {
	const reply = await callProfile(env, query, { method: "resume", params: {} }, deps);
	return reply.success;
}
