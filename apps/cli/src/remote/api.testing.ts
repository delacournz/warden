import type { Fetch } from "./api";
import type { Me, Organization, RemoteDevice } from "./api.types";

type Poll = "pending" | "slow_down" | "denied" | "expired" | "approve";

export type FakeServer = {
	fetch: Fetch;
	calls: Array<{ method: string; path: string; auth?: string; body?: Record<string, unknown> }>;
	/** device-token answers, in order; then `authorization_pending` */
	polls: Poll[];
	token: string;
	me: Me;
	orgs: Organization[];
	devices: Map<string, RemoteDevice>;
	/** `GET /v1/devices/:id` calls before a starting device reports ready */
	readyAfterGets: number;
	/** viewer tokens minted so far, newest last (`wvt_<n>`) */
	viewerTokens: Array<{ deviceId: string; scope: string; ttlS?: number; token: string }>;
};

type Request = { method: string; path: string; body: Record<string, unknown> };
type Handler = (server: FakeServer, req: Request) => Response;

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const POLL_ERRORS: Record<Exclude<Poll, "approve">, string> = {
	pending: "authorization_pending",
	slow_down: "slow_down",
	denied: "access_denied",
	expired: "expired_token",
};

/** Routes that need no session. */
const PUBLIC: Record<string, Handler> = {
	"POST /api/auth/device/code": () =>
		json({
			device_code: "dc1",
			user_code: "WXYZ-1234",
			verification_uri: "https://app.test/device",
			verification_uri_complete: "https://app.test/device?user_code=WXYZ-1234",
			expires_in: 600,
			interval: 1,
		}),
	"POST /api/auth/device/token": (server) => {
		const next = server.polls.shift() ?? "pending";
		return next === "approve"
			? json({ access_token: server.token, token_type: "Bearer" })
			: json({ error: POLL_ERRORS[next] }, 400);
	},
};

const AUTHED: Record<string, Handler> = {
	"GET /v1/me": (server) => json(server.me),
	"POST /api/auth/sign-out": () => json({ success: true }),
	"GET /api/auth/organization/list": (server) => json(server.orgs),
	"POST /api/auth/organization/set-active": (_, req) => json({ id: req.body.organizationId }),
	"GET /v1/devices": (server) => json([...server.devices.values()]),
	"POST /v1/devices": (server, { body }) => {
		const id = `rd${server.devices.size + 1}`;
		const device: RemoteDevice = {
			id,
			platform: body.platform === "android" ? "android" : "ios",
			status: "starting",
			idleTimeoutS: typeof body.idleTimeoutS === "number" ? body.idleTimeoutS : 300,
			startedAt: "2026-10-28T00:00:00.000Z",
			...(typeof body.deviceModel === "string" ? { deviceModel: body.deviceModel } : {}),
		};
		server.devices.set(id, device);
		return json(device, 202);
	},
};

/** `POST /v1/devices/:id/viewer-token`: 404 for a stopped device, ttl clamped to 60..1800 like the server. */
function viewerToken(server: FakeServer, device: RemoteDevice, body: Record<string, unknown>): Response {
	if (device.status === "stopped") return json({ success: false, error: "no such device", code: "NOT_FOUND" }, 404);
	const scope = body.scope === "view" ? "view" : "drive";
	const ttlS = typeof body.ttlS === "number" ? body.ttlS : undefined;
	const token = `wvt_${server.viewerTokens.length + 1}`;
	server.viewerTokens.push({ deviceId: device.id, scope, ...(ttlS !== undefined ? { ttlS } : {}), token });
	const clamped = Math.min(1800, Math.max(60, ttlS ?? 600));
	return json({ token, expiresAt: new Date(Date.UTC(2026, 9, 29) + clamped * 1000).toISOString() });
}

function deviceRoute(server: FakeServer, req: Request): Response | undefined {
	const id = req.path.match(/^\/v1\/devices\/([^/]+)(?:\/heartbeat|\/viewer-token)?$/)?.[1];
	if (id === undefined) return undefined;
	const device = server.devices.get(id);
	if (!device) return json({ success: false, error: "no such device", code: "NOT_FOUND" }, 404);
	if (req.method === "POST" && req.path.endsWith("/heartbeat")) return json(device);
	if (req.method === "POST" && req.path.endsWith("/viewer-token")) return viewerToken(server, device, req.body);
	if (req.method === "DELETE") {
		device.status = "stopped";
		return json({ stopped: true });
	}
	if (device.status === "starting" && --server.readyAfterGets <= 0) {
		device.status = "ready";
		device.readyAt = "2026-10-28T00:00:30.000Z";
	}
	return json(device);
}

/** An in-memory warden-api: device-flow login, `/v1/me`, organizations and `/v1/devices`. */
export function fakeServer(
	overrides: Partial<Pick<FakeServer, "me" | "orgs" | "polls" | "readyAfterGets">> = {}
): FakeServer {
	const server: FakeServer = {
		calls: [],
		polls: overrides.polls ?? ["approve"],
		token: "sess_tok",
		me: overrides.me ?? {
			user: { id: "u1", email: "dev@acme.test", name: "Dev" },
			organization: { id: "o1", name: "Acme", slug: "acme" },
			remote: { state: "connected", concurrencyLimit: 2, active: 0 },
		},
		orgs: overrides.orgs ?? [
			{ id: "o1", name: "Acme", slug: "acme" },
			{ id: "o2", name: "Side", slug: "side" },
		],
		devices: new Map(),
		viewerTokens: [],
		readyAfterGets: overrides.readyAfterGets ?? 1,
		fetch: async (input, init) => {
			const path = new URL(input).pathname;
			const method = init?.method ?? "GET";
			const auth = new Headers(init?.headers).get("authorization") ?? undefined;
			const body: Record<string, unknown> = typeof init?.body === "string" ? JSON.parse(init.body) : {};
			server.calls.push({
				method,
				path,
				...(auth ? { auth } : {}),
				...(typeof init?.body === "string" ? { body } : {}),
			});
			const req = { method, path, body };
			const route = `${method} ${path}`;
			const open = PUBLIC[route];
			if (open) return open(server, req);
			if (auth !== `Bearer ${server.token}`) {
				return json({ success: false, error: "no session", code: "UNAUTHORIZED" }, 401);
			}
			const handler = AUTHED[route];
			if (handler) return handler(server, req);
			return deviceRoute(server, req) ?? json({ success: false, error: `no route ${route}`, code: "NOT_FOUND" }, 404);
		},
	};
	return server;
}
