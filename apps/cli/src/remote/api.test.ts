import { describe, expect, test } from "bun:test";
import { createWardenApi, type Fetch, WARDEN_CLI_CLIENT_ID } from "./api";
import type { DeviceTokenPoll, Me, RemoteDevice } from "./api.types";

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
});
