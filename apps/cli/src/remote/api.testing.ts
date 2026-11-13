import type { Fetch } from "./api";
import type { Billing, LedgerEntry, Me, Organization, RemoteDevice } from "./api.types";

type Poll = "pending" | "slow_down" | "denied" | "expired" | "approve";

export type FakeServer = {
	fetch: Fetch;
	calls: Array<{
		method: string;
		path: string;
		auth?: string;
		body?: Record<string, unknown>;
		/** the `X-Warden-Machine` header, when sent */
		machine?: string;
		/** the `X-Warden-Organization` header, when sent */
		organization?: string;
	}>;
	/** device-token answers, in order; then `authorization_pending` */
	polls: Poll[];
	/** the first session token minted; later approvals mint `<token>_2`, `<token>_3`, … */
	token: string;
	/** every session token minted so far (each one authenticates) */
	issued: string[];
	me: Me;
	orgs: Organization[];
	/** slugs other people's organizations hold: `check-slug` / `create` answer `ORGANIZATION_SLUG_ALREADY_TAKEN` */
	takenSlugs: string[];
	devices: Map<string, RemoteDevice>;
	/** `GET /v1/devices/:id` calls before a starting device reports ready */
	readyAfterGets: number;
	/** viewer tokens minted so far, newest last (`wvt_<n>`) */
	viewerTokens: Array<{ deviceId: string; scope: string; ttlS?: number; token: string }>;
	billing: Billing;
	/** `GET /v1/billing/ledger`, newest first */
	ledger: LedgerEntry[];
	/** hashes `POST /v1/machines` received */
	machines: string[];
	/** answer the next `POST /v1/devices` with this error instead of a device (402 / 403 cases) */
	createError?: { status: number; body: Record<string, unknown> };
	/** answer `POST /v1/billing/topups` with this error (403 `BILLING_ROLE`) */
	topupError?: { status: number; body: Record<string, unknown> };
};

type Request = { method: string; path: string; body: Record<string, unknown>; query: URLSearchParams };
type Handler = (server: FakeServer, req: Request) => Response;

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const POLL_ERRORS: Record<Exclude<Poll, "approve">, string> = {
	pending: "authorization_pending",
	slow_down: "slow_down",
	denied: "access_denied",
	expired: "expired_token",
};

/** A fresh session token per approved device flow, like the real server. */
function mint(server: FakeServer): string {
	const token = server.issued.length === 0 ? server.token : `${server.token}_${server.issued.length + 1}`;
	server.issued.push(token);
	return token;
}

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
			? json({ access_token: mint(server), token_type: "Bearer" })
			: json({ error: POLL_ERRORS[next] }, 400);
	},
};

const AUTHED: Record<string, Handler> = {
	"GET /v1/me": (server) => json(server.me),
	"POST /api/auth/sign-out": () => json({ success: true }),
	"GET /api/auth/organization/list": (server) => json(server.orgs),
	"POST /api/auth/organization/set-active": (_, req) => json({ id: req.body.organizationId }),
	"POST /api/auth/organization/check-slug": (server, { body }) =>
		server.orgs.some((o) => o.slug === body.slug) || server.takenSlugs.includes(String(body.slug))
			? json({ code: "ORGANIZATION_SLUG_ALREADY_TAKEN", message: "slug is taken" }, 400)
			: json({ status: true }),
	"POST /api/auth/organization/create": (server, { body }) => {
		const slug = String(body.slug);
		if (server.orgs.some((o) => o.slug === slug) || server.takenSlugs.includes(slug)) {
			return json({ code: "ORGANIZATION_SLUG_ALREADY_TAKEN", message: "slug is taken" }, 400);
		}
		const org = { id: `o${server.orgs.length + 1}`, name: String(body.name), slug };
		server.orgs.push(org);
		server.me = { ...server.me, organization: org };
		return json({ ...org, createdAt: "2026-11-01T00:00:00.000Z", members: [] });
	},
	"GET /v1/devices": (server) => json([...server.devices.values()]),
	"POST /v1/machines": (server, { body }) => {
		if (typeof body.hash !== "string" || !/^[0-9a-f]{64}$/.test(body.hash)) {
			return json({ success: false, error: "bad hash", code: "VALIDATION" }, 400);
		}
		server.machines.push(body.hash);
		return new Response(null, { status: 204 });
	},
	"GET /v1/billing": (server) => json(server.billing),
	"GET /v1/billing/ledger": (server, { query }) =>
		json({ entries: server.ledger.slice(0, Number(query.get("limit") ?? server.ledger.length)) }),
	"POST /v1/billing/topups": (server, { body }) =>
		server.topupError
			? json(server.topupError.body, server.topupError.status)
			: json({ checkoutUrl: `https://checkout.stripe.test/pay/cs_${String(body.amountUsd)}` }),
	"POST /v1/devices": (server, { body }) => {
		if (server.createError) return json(server.createError.body, server.createError.status);
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

/** Log one request in `server.calls`; returns its bearer and parsed JSON body. */
function recordCall(
	server: FakeServer,
	method: string,
	path: string,
	init: RequestInit | undefined
): { auth?: string; body: Record<string, unknown> } {
	const headers = new Headers(init?.headers);
	const auth = headers.get("authorization") ?? undefined;
	const machine = headers.get("x-warden-machine") ?? undefined;
	const organization = headers.get("x-warden-organization") ?? undefined;
	const raw = typeof init?.body === "string" ? init.body : undefined;
	const body: Record<string, unknown> = raw ? JSON.parse(raw) : {};
	server.calls.push({
		method,
		path,
		...(auth ? { auth } : {}),
		...(raw !== undefined ? { body } : {}),
		...(machine ? { machine } : {}),
		...(organization ? { organization } : {}),
	});
	return { ...(auth ? { auth } : {}), body };
}

/** An in-memory warden-api: device-flow login, `/v1/me`, organizations and `/v1/devices`. */
export function fakeServer(
	overrides: Partial<
		Pick<FakeServer, "me" | "orgs" | "polls" | "readyAfterGets" | "billing" | "ledger" | "takenSlugs">
	> = {}
): FakeServer {
	const server: FakeServer = {
		calls: [],
		polls: overrides.polls ?? ["approve"],
		token: "sess_tok",
		issued: [],
		me: overrides.me ?? {
			user: { id: "u1", email: "dev@acme.test", name: "Dev" },
			organization: { id: "o1", name: "Acme", slug: "acme" },
			remote: { state: "connected", concurrencyLimit: 2, active: 0 },
		},
		orgs: overrides.orgs ?? [
			{ id: "o1", name: "Acme", slug: "acme" },
			{ id: "o2", name: "Side", slug: "side" },
		],
		takenSlugs: overrides.takenSlugs ?? [],
		devices: new Map(),
		viewerTokens: [],
		readyAfterGets: overrides.readyAfterGets ?? 1,
		billing: overrides.billing ?? {
			balanceUsd: 1.6,
			ratePerMinuteUsd: 0.2,
			estMinutesLeft: 8,
			lowBalance: false,
			trial: { state: "active", amountUsd: 2 },
			billingUrl: "https://app.warden.test/billing",
		},
		ledger: overrides.ledger ?? [
			{ id: "l2", kind: "usage", amountUsd: -0.4, createdAt: "2026-10-30T00:02:00.000Z" },
			{ id: "l1", kind: "grant", amountUsd: 2, createdAt: "2026-10-30T00:00:00.000Z" },
		],
		machines: [],
		fetch: async (input, init) => {
			const url = new URL(input);
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const { auth, body } = recordCall(server, method, path, init);
			const req = { method, path, body, query: url.searchParams };
			const route = `${method} ${path}`;
			const open = PUBLIC[route];
			if (open) return open(server, req);
			if (!server.issued.concat(server.token).some((t) => auth === `Bearer ${t}`)) {
				return json({ success: false, error: "no session", code: "UNAUTHORIZED" }, 401);
			}
			const handler = AUTHED[route];
			if (handler) return handler(server, req);
			return deviceRoute(server, req) ?? json({ success: false, error: `no route ${route}`, code: "NOT_FOUND" }, 404);
		},
	};
	return server;
}
