import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { z } from "zod";
import type { HostFault } from "../conditions/conditions.types";
import type { ProxyConditions, ShapingParams } from "./shaping";

/** Where a running proxy listens and how to steer it. Persisted as JSON so another process can find it. */
export type ProxyHandle = {
	pid: number;
	/** loopback address the proxy and control channel bind */
	host: string;
	/** the forward proxy: what a device's HTTP proxy setting points at */
	port: number;
	/** loopback HTTP control channel */
	controlPort: number;
	/** required as `x-warden-token` on every control call */
	token: string;
};

export type ProxyStats = {
	connections: number;
	resets: number;
	stalls: number;
	faulted: number;
	bytesUp: number;
	bytesDown: number;
};

export type ProxyStatus = ProxyConditions & { pid: number; stats: ProxyStats };

/** Replace `params` and/or `faults`; an omitted field keeps its current value. */
export type ConditionsUpdate = { params?: ShapingParams; faults?: readonly HostFault[] };

const nonNegative = z.number().finite().min(0);

const paramsSchema = z.strictObject({
	latencyMs: nonNegative.optional(),
	jitterMs: nonNegative.optional(),
	downKbps: nonNegative.optional(),
	upKbps: nonNegative.optional(),
	lossPct: z.number().min(0).max(100).optional(),
	offline: z.enum(["refuse", "blackhole"]).optional(),
});

const faultSchema = z.strictObject({
	match: z.string().min(1),
	action: z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("status"), code: z.number().int().min(100).max(599) }),
		z.strictObject({ kind: z.literal("reset") }),
		z.strictObject({ kind: z.literal("delay"), ms: nonNegative }),
		z.strictObject({ kind: z.literal("blackhole") }),
	]),
});

export const conditionsUpdateSchema = z.strictObject({
	params: paramsSchema.optional(),
	faults: z.array(faultSchema).optional(),
});

/** What the control server needs from the proxy it steers. */
export type ControlApi = {
	status(): ProxyStatus;
	update(update: ConditionsUpdate): void;
	shutdown(): void;
};

/** Loopback HTTP control channel: `GET /status`, `PUT /conditions`, `POST /shutdown`; token-guarded. */
export function serveControl(api: ControlApi, token: string, host: string) {
	return Bun.serve({
		hostname: host,
		port: 0,
		async fetch(req) {
			if (req.headers.get("x-warden-token") !== token) return new Response("forbidden", { status: 403 });
			const { pathname } = new URL(req.url);
			if (req.method === "GET" && pathname === "/status") return Response.json(api.status());
			if (req.method === "PUT" && pathname === "/conditions") {
				const body = conditionsUpdateSchema.safeParse(await req.json().catch(() => undefined));
				if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });
				api.update(body.data as ConditionsUpdate);
				return Response.json(api.status());
			}
			if (req.method === "POST" && pathname === "/shutdown") {
				setTimeout(() => api.shutdown(), 0);
				return Response.json({ ok: true });
			}
			return new Response("not found", { status: 404 });
		},
	});
}

async function call<T>(handle: ProxyHandle, method: string, path: string, body?: unknown): AsyncResult<T> {
	try {
		const res = await fetch(`http://${handle.host}:${handle.controlPort}${path}`, {
			method,
			headers: { "x-warden-token": handle.token, "content-type": "application/json" },
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return err(`netproxy ${method} ${path}: ${res.status} ${await res.text()}`);
		return ok((await res.json()) as T);
	} catch (error) {
		return err(`netproxy ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Live-reconfigure a running proxy without dropping its listener or open connections. */
export function setProxyConditions(handle: ProxyHandle, update: ConditionsUpdate): AsyncResult<ProxyStatus> {
	return call<ProxyStatus>(handle, "PUT", "/conditions", update);
}

export function getProxyStatus(handle: ProxyHandle): AsyncResult<ProxyStatus> {
	return call<ProxyStatus>(handle, "GET", "/status");
}

/** Ask the proxy to close its listeners and exit. */
export function stopProxy(handle: ProxyHandle): AsyncResult<{ ok: true }> {
	return call<{ ok: true }>(handle, "POST", "/shutdown");
}
