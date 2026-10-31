import { describe, expect, test } from "bun:test";
import { createWardenApi, type Fetch, WARDEN_CLI_CLIENT_ID } from "./api";
import type { Billing, DeviceTokenPoll, Me, RemoteDevice } from "./api.types";

type Call = { method: string; url: string; headers: Record<string, string>; body?: unknown };

function fakeFetch(routes: Record<string, () => Response>, calls: Call[] = []): Fetch {
	return async (input, init) => {
		const method = init?.method ?? "GET";
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, url: input, headers, body });
		const route = routes[`${method} ${new URL(input).pathname}`];
		return route ? route() : new Response("nope", { status: 404 });
	};
}

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("warden api client", () => {
	test("device code: maps snake_case and sends the CLI client id", async () => {
		const calls: Call[] = [];
		const api = createWardenApi({
			baseUrl: "https://api.test/",
			fetch: fakeFetch(
				{
					"POST /api/auth/device/code": () =>
						json({
							device_code: "dc",
							user_code: "ABCD-EFGH",
							verification_uri: "https://app.test/device",
							verification_uri_complete: "https://app.test/device?user_code=ABCD-EFGH",
							expires_in: 900,
							interval: 5,
						}),
				},
				calls
			),
		});
		const r = await api.deviceCode();
		expect(r).toEqual({
			success: true,
			data: {
				deviceCode: "dc",
				userCode: "ABCD-EFGH",
				verificationUri: "https://app.test/device",
				verificationUriComplete: "https://app.test/device?user_code=ABCD-EFGH",
				expiresIn: 900,
				interval: 5,
			},
		});
		expect(calls[0]?.url).toBe("https://api.test/api/auth/device/code");
		expect(calls[0]?.body).toEqual({ client_id: WARDEN_CLI_CLIENT_ID });
	});

	test("device token: each RFC 8628 outcome", async () => {
		const outcomes: Array<[Response, DeviceTokenPoll]> = [
			[json({ access_token: "tok", token_type: "Bearer" }), { kind: "token", token: "tok" }],
			[json({ error: "authorization_pending" }, 400), { kind: "pending" }],
			[json({ error: "slow_down" }, 400), { kind: "slow_down" }],
			[json({ error: "access_denied" }, 400), { kind: "denied" }],
			[json({ error: "expired_token" }, 400), { kind: "expired" }],
		];
		for (const [response, expected] of outcomes) {
			const api = createWardenApi({
				baseUrl: "https://api.test",
				fetch: fakeFetch({ "POST /api/auth/device/token": () => response }),
			});
			expect(await api.deviceToken("dc")).toEqual({ success: true, data: expected });
		}
	});

	test("authenticated calls send the bearer token; 401 is unauthorized", async () => {
		const calls: Call[] = [];
		const me: Me = {
			user: { id: "u1", email: "a@b.test" },
			organization: { id: "o1", name: "Acme", slug: "acme" },
			remote: { state: "connected", active: 0 },
		};
		const api = createWardenApi({
			baseUrl: "https://api.test",
			token: "tok",
			fetch: fakeFetch({ "GET /v1/me": () => json(me) }, calls),
		});
		expect(await api.me()).toEqual({ success: true, data: me });
		expect(calls[0]?.headers.authorization).toBe("Bearer tok");

		const denied = createWardenApi({
			baseUrl: "https://api.test",
			token: "bad",
			fetch: fakeFetch({
				"GET /v1/me": () => json({ success: false, error: "no session", code: "UNAUTHORIZED" }, 401),
			}),
		});
		const r = await denied.me();
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.kind).toBe("unauthorized");
	});

	test("devices: create, get, stop", async () => {
		const device: RemoteDevice = {
			id: "d1",
			platform: "ios",
			status: "starting",
			idleTimeoutS: 300,
			startedAt: "2026-10-28T00:00:00Z",
		};
		const calls: Call[] = [];
		const api = createWardenApi({
			baseUrl: "https://api.test",
			token: "tok",
			fetch: fakeFetch(
				{
					"POST /v1/devices": () => json(device, 202),
					"GET /v1/devices/d1": () => json({ ...device, status: "ready" }),
					"DELETE /v1/devices/d1": () => json({ stopped: true }),
				},
				calls
			),
		});
		expect(await api.createDevice({ platform: "ios", idleTimeoutS: 300 })).toEqual({ success: true, data: device });
		expect(calls[0]?.body).toEqual({ platform: "ios", idleTimeoutS: 300 });
		const got = await api.getDevice("d1");
		expect(got.success && got.data.status).toBe("ready");
		expect(await api.stopDevice("d1")).toEqual({ success: true, data: { stopped: true } });
	});

	test("errors carry the server code; network failures are network errors", async () => {
		const api = createWardenApi({
			baseUrl: "https://api.test",
			token: "tok",
			fetch: fakeFetch({
				"POST /v1/devices": () => json({ success: false, error: "quota reached", code: "QUOTA_EXCEEDED" }, 429),
			}),
		});
		expect(await api.createDevice({ platform: "android" })).toEqual({
			success: false,
			error: { kind: "http", status: 429, code: "QUOTA_EXCEEDED", message: "quota reached" },
		});

		const offline = createWardenApi({
			baseUrl: "https://api.test",
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
		});
		expect(await offline.me()).toEqual({ success: false, error: { kind: "network", message: "fetch failed" } });
	});

	test("organizations: list and set active", async () => {
		const calls: Call[] = [];
		const api = createWardenApi({
			baseUrl: "https://api.test",
			token: "tok",
			fetch: fakeFetch(
				{
					"GET /api/auth/organization/list": () => json([{ id: "o1", name: "Acme", slug: "acme", extra: 1 }]),
					"POST /api/auth/organization/set-active": () => json({ id: "o1" }),
				},
				calls
			),
		});
		expect(await api.listOrganizations()).toEqual({ success: true, data: [{ id: "o1", name: "Acme", slug: "acme" }] });
		expect((await api.setActiveOrganization("o1")).success).toBe(true);
		expect(calls[1]?.body).toEqual({ organizationId: "o1" });
	});

	test("viewer token: scope and ttl in the body, 404 and bad bodies are errors", async () => {
		const calls: Call[] = [];
		const api = createWardenApi({
			baseUrl: "https://api.test",
			token: "tok",
			fetch: fakeFetch(
				{
					"POST /v1/devices/d1/viewer-token": () => json({ token: "wvt_abc", expiresAt: "2026-10-29T00:10:00.000Z" }),
					"POST /v1/devices/gone/viewer-token": () => json({ success: false, error: "no such device" }, 404),
					"POST /v1/devices/odd/viewer-token": () => json({ token: 5 }),
				},
				calls
			),
		});
		expect(await api.viewerToken("d1", "view")).toEqual({
			success: true,
			data: { token: "wvt_abc", expiresAt: "2026-10-29T00:10:00.000Z" },
		});
		await api.viewerToken("d1", "drive", 1800);
		expect(calls[0]?.body).toEqual({ scope: "view" });
		expect(calls[1]?.body).toEqual({ scope: "drive", ttlS: 1800 });
		expect(calls[0]?.headers.authorization).toBe("Bearer tok");
		expect(await api.viewerToken("gone", "view")).toEqual({
			success: false,
			error: { kind: "not_found", message: "no such device" },
		});
		const odd = await api.viewerToken("odd", "view");
		expect(!odd.success && odd.error.kind).toBe("invalid_response");
	});
});

describe("warden cloud billing", () => {
	const authed = (routes: Record<string, () => Response>, calls: Call[] = []) =>
		createWardenApi({ baseUrl: "https://api.test", token: "tok", fetch: fakeFetch(routes, calls) });
	const device = { id: "d1", platform: "ios", status: "ready", idleTimeoutS: 300, startedAt: "2026-10-30T00:00:00Z" };

	test("registerMachine posts the hash and takes a 204", async () => {
		const calls: Call[] = [];
		const api = authed({ "POST /v1/machines": () => new Response(null, { status: 204 }) }, calls);
		expect(await api.registerMachine("a".repeat(64))).toEqual({ success: true, data: undefined });
		expect(calls[0]?.body).toEqual({ hash: "a".repeat(64) });
	});

	test("createDevice sends X-Warden-Machine only when given a hash", async () => {
		const calls: Call[] = [];
		const api = authed({ "POST /v1/devices": () => json(device, 202) }, calls);
		await api.createDevice({ platform: "ios" }, { machine: "b".repeat(64) });
		await api.createDevice({ platform: "ios" });
		expect(calls[0]?.headers["x-warden-machine"]).toBe("b".repeat(64));
		expect(calls[1]?.headers["x-warden-machine"]).toBeUndefined();
	});

	test("X-Warden-Organization rides on every authed call when an organization is set", async () => {
		const calls: Call[] = [];
		const routes = { "GET /v1/billing": () => json({}), "POST /v1/devices": () => json(device, 202) };
		const withOrg = createWardenApi({
			baseUrl: "https://api.test",
			token: "tok",
			organization: "org-1",
			fetch: fakeFetch(routes, calls),
		});
		await withOrg.getBilling();
		await withOrg.createDevice({ platform: "ios" });
		await authed(routes, calls).getBilling();
		expect(calls.map((c) => c.headers["x-warden-organization"] ?? "none")).toEqual(["org-1", "org-1", "none"]);
	});

	test("no X-Warden-Organization without a token (login endpoints)", async () => {
		const calls: Call[] = [];
		const anon = createWardenApi({
			baseUrl: "https://api.test",
			organization: "org-1",
			fetch: fakeFetch({ "POST /api/auth/device/code": () => json({}) }, calls),
		});
		await anon.deviceCode();
		expect(calls[0]?.headers["x-warden-organization"]).toBeUndefined();
	});

	test("402 CREDITS_EXHAUSTED keeps the billing url", async () => {
		const api = authed({
			"POST /v1/devices": () =>
				json(
					{
						success: false,
						code: "CREDITS_EXHAUSTED",
						error: "out of credits",
						billingUrl: "https://app.warden.co.nz/billing",
					},
					402
				),
		});
		expect(await api.createDevice({ platform: "ios" })).toEqual({
			success: false,
			error: {
				kind: "payment_required",
				code: "CREDITS_EXHAUSTED",
				message: "out of credits",
				billingUrl: "https://app.warden.co.nz/billing",
			},
		});
	});

	test("403 MACHINE_REQUIRED_FOR_TRIAL is a forbidden error with its code", async () => {
		const api = authed({
			"POST /v1/devices": () =>
				json({ success: false, code: "MACHINE_REQUIRED_FOR_TRIAL", error: "trial needs a machine" }, 403),
		});
		const r = await api.createDevice({ platform: "ios" });
		expect(r).toEqual({
			success: false,
			error: { kind: "forbidden", code: "MACHINE_REQUIRED_FOR_TRIAL", message: "trial needs a machine" },
		});
	});

	test("devices carry stopReason and billing; unknown stop reasons are dropped", async () => {
		const api = authed({
			"GET /v1/devices/d1": () =>
				json({
					...device,
					status: "stopped",
					stopReason: "credits_exhausted",
					billing: { balanceUsd: 0, lowBalance: true },
				}),
			"GET /v1/devices/d2": () => json({ ...device, id: "d2", stopReason: "meteor", billing: { balanceUsd: "x" } }),
		});
		const r = await api.getDevice("d1");
		expect(r.success && r.data).toMatchObject({
			stopReason: "credits_exhausted",
			billing: { balanceUsd: 0, lowBalance: true },
		});
		const other = await api.getDevice("d2");
		expect(other.success && other.data.stopReason).toBeUndefined();
		expect(other.success && other.data.billing).toBeUndefined();
	});

	test("getBilling parses the account summary", async () => {
		const body: Billing = {
			balanceUsd: 1.5,
			ratePerMinuteUsd: 0.2,
			estMinutesLeft: 7.5,
			lowBalance: false,
			trial: { state: "active", amountUsd: 2 },
			billingUrl: "https://app.warden.co.nz/billing",
		};
		const api = authed({ "GET /v1/billing": () => json(body) });
		expect(await api.getBilling()).toEqual({ success: true, data: body });
		const bad = authed({ "GET /v1/billing": () => json({ ...body, trial: { state: "maybe", amountUsd: 2 } }) });
		expect(await bad.getBilling()).toMatchObject({ success: false, error: { kind: "invalid_response" } });
	});

	test("createTopup posts the amount and returns the checkout url; members get BILLING_ROLE", async () => {
		const calls: Call[] = [];
		const api = authed(
			{ "POST /v1/billing/topups": () => json({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_1" }) },
			calls
		);
		expect(await api.createTopup(20)).toEqual({
			success: true,
			data: { checkoutUrl: "https://checkout.stripe.com/c/pay/cs_1" },
		});
		expect(calls[0]?.body).toEqual({ amountUsd: 20 });
		const member = authed({
			"POST /v1/billing/topups": () => json({ success: false, code: "BILLING_ROLE", error: "owners only" }, 403),
		});
		expect(await member.createTopup(20)).toMatchObject({ success: false, error: { code: "BILLING_ROLE" } });
	});

	test("listLedger reads entries (micro-USD or USD) and asks for a limit", async () => {
		const calls: Call[] = [];
		const api = authed(
			{
				"GET /v1/billing/ledger": () =>
					json({
						entries: [
							{ id: "l2", kind: "usage", amountMicrousd: -400000, createdAt: "2026-10-30T01:00:00Z" },
							{ id: "l1", kind: "grant", amountUsd: 2, createdAt: "2026-10-30T00:00:00Z" },
							{ id: "l0", kind: "mystery", amountUsd: 1, createdAt: "2026-10-29T00:00:00Z" },
						],
						nextCursor: "c2",
					}),
			},
			calls
		);
		const r = await api.listLedger({ limit: 5 });
		expect(r).toEqual({
			success: true,
			data: {
				entries: [
					{ id: "l2", kind: "usage", amountUsd: -0.4, createdAt: "2026-10-30T01:00:00Z" },
					{ id: "l1", kind: "grant", amountUsd: 2, createdAt: "2026-10-30T00:00:00Z" },
					{ id: "l0", kind: "other", amountUsd: 1, createdAt: "2026-10-29T00:00:00Z" },
				],
				nextCursor: "c2",
			},
		});
		expect(calls[0]?.url).toBe("https://api.test/v1/billing/ledger?limit=5");
	});

	test("me.remote carries balanceUsd when the server sends it", async () => {
		const api = authed({
			"GET /v1/me": () =>
				json({
					user: { id: "u", email: "e@x.test" },
					organization: null,
					remote: { state: "connected", active: 0, balanceUsd: 3.25 },
				}),
		});
		const r = await api.me();
		expect(r.success && r.data.remote).toEqual({ state: "connected", active: 0, balanceUsd: 3.25 });
	});
});
