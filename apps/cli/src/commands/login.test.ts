import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { fakeServer } from "../remote/api.testing";
import type { Me } from "../remote/api.types";
import { credentialsPath, readCredentials } from "../remote/credentials";
import { hashMachineId } from "../remote/machine";
import { fakeExec, scriptedUi, type TestContext, testContext } from "../testing";
import { loginCommand } from "./login";
import { logoutCommand } from "./logout";
import { orgCommand } from "./org";
import { whoamiCommand } from "./whoami";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function setup(server = fakeServer(), calls: string[][] = []): TestContext {
	ctx = testContext([], { fetch: server.fetch, sleep: async () => {}, exec: fakeExec([["open", {}]], calls) });
	ctx.env = { ...ctx.env, WARDEN_API_URL: "https://api.test" };
	return ctx;
}

describe("warden login", () => {
	test("device flow → token saved 0600 with the active org", async () => {
		const server = fakeServer({ polls: ["pending", "slow_down", "approve"] });
		const c = setup(server);
		c.argv = ["--json"];
		expect(await loginCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({
			apiUrl: "https://api.test",
			user: { email: "dev@acme.test" },
			organization: { slug: "acme" },
		});
		const saved = readCredentials(c.env);
		expect(saved).toMatchObject({
			success: true,
			data: { token: "sess_tok", organizationId: "o1", apiUrl: "https://api.test" },
		});
		expect(statSync(credentialsPath(c.env)).mode & 0o777).toBe(0o600);
		expect(c.stderr.join("\n")).toContain("WXYZ-1234");
	});

	test("opens the browser only when interactive", async () => {
		const calls: string[][] = [];
		const c = setup(fakeServer(), calls);
		c.ui = scriptedUi({ interactive: true });
		c.os = "darwin";
		expect(await loginCommand.run(c)).toBe(0);
		expect(calls.filter((c) => c[0] === "open")).toEqual([["open", "https://app.test/device?user_code=WXYZ-1234"]]);

		const quiet: string[][] = [];
		const d = setup(fakeServer(), quiet);
		expect(await loginCommand.run(d)).toBe(0);
		expect(quiet.filter((c) => c[0] === "open")).toEqual([]);
	});

	test("registers this machine's hashed id after logging in", async () => {
		const server = fakeServer();
		const c = setup(server);
		c.os = "darwin";
		c.exec = fakeExec([["ioreg", { stdout: '"IOPlatformUUID" = "8F1C2D3E-4A5B-6C7D-8E9F-0A1B2C3D4E5F"' }]]);
		c.argv = ["--json"];
		expect(await loginCommand.run(c)).toBe(0);
		expect(server.machines).toEqual([hashMachineId("8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f")]);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ machine: "registered" });
	});

	test("no machine id (CI): logs in without registering one", async () => {
		const server = fakeServer();
		const c = setup(server);
		c.env = { ...c.env, CI: "true" };
		c.argv = ["--json"];
		expect(await loginCommand.run(c)).toBe(0);
		expect(server.machines).toEqual([]);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ machine: "none" });
	});

	test("denied in the browser: exit 1, nothing saved", async () => {
		const c = setup(fakeServer({ polls: ["denied"] }));
		expect(await loginCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("denied");
		expect(readCredentials(c.env)).toEqual({ success: true, data: undefined });
	});
});

describe("warden whoami / org / logout", () => {
	async function loggedIn(server = fakeServer()) {
		const c = setup(server);
		expect(await loginCommand.run(c)).toBe(0);
		c.stdout.length = 0;
		c.stderr.length = 0;
		return c;
	}

	test("whoami without a login fails with the hint", async () => {
		const c = setup();
		expect(await whoamiCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("warden login");
	});

	test("whoami --json reports the account and remote status", async () => {
		const c = await loggedIn();
		c.argv = ["--json"];
		expect(await whoamiCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({
			source: "saved",
			user: { email: "dev@acme.test" },
			remote: { state: "connected", concurrencyLimit: 2 },
		});
	});

	test("whoami shows balance, minutes left and trial state", async () => {
		const c = await loggedIn();
		c.argv = ["--json"];
		expect(await whoamiCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).billing).toMatchObject({
			balanceUsd: 1.6,
			estMinutesLeft: 8,
			trial: { state: "active", amountUsd: 2 },
		});
		c.stdout.length = 0;
		c.argv = [];
		expect(await whoamiCommand.run(c)).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).toContain("$1.60");
		expect(text).toContain("~8 min left at $0.20/min");
		expect(text).toContain("trial         active ($2.00)");
	});

	test("whoami still works when billing is unavailable", async () => {
		const server = fakeServer();
		const c = await loggedIn(server);
		server.fetch = (
			(inner) => async (input: string, init?: RequestInit) =>
				new URL(input).pathname === "/v1/billing" ? new Response("nope", { status: 404 }) : inner(input, init)
		)(server.fetch);
		c.fetch = server.fetch;
		c.argv = ["--json"];
		expect(await whoamiCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).billing).toBeNull();
	});

	test("whoami shows the Revyl approval code while the workspace awaits approval", async () => {
		const server = fakeServer();
		const c = await loggedIn(server);
		const approval = {
			userCode: "WDN-4821",
			uri: "https://app.revyl.ai/connect?code=WDN-4821",
			expiresAt: "2026-11-07T00:00:00.000Z",
		};
		server.fetch = ((inner) => async (input: string, init?: RequestInit) => {
			if (new URL(input).pathname !== "/v1/me") return inner(input, init);
			const me = (await (await inner(input, init)).json()) as Me;
			return Response.json({ ...me, remote: { active: 0, ...me.remote, state: "awaiting_approval", approval } });
		})(server.fetch);
		c.fetch = server.fetch;
		c.argv = ["--json"];
		expect(await whoamiCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).remote).toMatchObject({ state: "awaiting_approval", approval });
		c.stdout.length = 0;
		c.argv = [];
		expect(await whoamiCommand.run(c)).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).toContain("approve in Revyl with code WDN-4821");
		expect(text).toContain(approval.uri);
	});

	test("WARDEN_TOKEN authenticates without a saved login", async () => {
		const c = setup();
		c.env = { ...c.env, WARDEN_TOKEN: "sess_tok" };
		c.argv = ["--json"];
		expect(await whoamiCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).source).toBe("env");
	});

	test("org list marks the active org; org use switches and saves it", async () => {
		const server = fakeServer();
		const c = await loggedIn(server);
		c.argv = ["list", "--json"];
		expect(await orgCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual([
			{ id: "o1", name: "Acme", slug: "acme", active: true },
			{ id: "o2", name: "Side", slug: "side", active: false },
		]);
		c.argv = ["use", "side"];
		expect(await orgCommand.run(c)).toBe(0);
		expect(server.calls.at(-1)).toMatchObject({
			path: "/api/auth/organization/set-active",
			body: { organizationId: "o2" },
		});
		expect(readCredentials(c.env)).toMatchObject({ data: { organizationId: "o2" } });
		c.argv = ["use", "nope"];
		expect(await orgCommand.run(c)).toBe(1);
	});

	test("logout revokes and forgets the token", async () => {
		const server = fakeServer();
		const c = await loggedIn(server);
		c.argv = ["--json"];
		expect(await logoutCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({ loggedOut: true, revoked: true });
		expect(server.calls.at(-1)?.path).toBe("/api/auth/sign-out");
		expect(readCredentials(c.env)).toEqual({ success: true, data: undefined });
	});
});
