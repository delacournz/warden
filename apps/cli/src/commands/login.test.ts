import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { fakeServer } from "../remote/api.testing";
import type { Me } from "../remote/api.types";
import { credentialsPath, readAccounts, readCredentials } from "../remote/credentials";
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
		const c = setup(fakeServer({ orgs: [{ id: "o1", name: "Acme", slug: "acme" }] }), calls);
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

describe("warden login: organizations", () => {
	const acme = { id: "o1", name: "Acme", slug: "acme" };
	const side = { id: "o2", name: "Side", slug: "side" };
	const noActive = { user: { id: "u1", email: "dev@acme.test" }, organization: null, remote: null };

	function accounts(c: TestContext) {
		const read = readAccounts(c.env);
		if (!read.success || !read.data) throw new Error("no accounts saved");
		return read.data;
	}

	test("no active org but one membership: picks it, sets it active, saves it", async () => {
		const server = fakeServer({ me: noActive, orgs: [acme] });
		const c = setup(server);
		c.argv = ["--json"];
		expect(await loginCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ organization: acme, profiles: [] });
		expect(
			server.calls.some((x) => x.path === "/api/auth/organization/set-active" && x.body?.organizationId === "o1")
		).toBe(true);
		expect(accounts(c)).toMatchObject({ default: "default", accounts: { default: { organizationId: "o1" } } });
	});

	test("no organizations: saves the login without one and says how to make one", async () => {
		const c = setup(fakeServer({ me: noActive, orgs: [] }));
		expect(await loginCommand.run(c)).toBe(0);
		expect(accounts(c).accounts.default?.organizationId).toBeUndefined();
		expect(c.stderr.join("\n")).toContain("no organization yet");
	});

	test("several orgs, interactive: asks for the default, saves the rest as slug profiles", async () => {
		const server = fakeServer({ me: noActive, orgs: [acme, side] });
		const c = setup(server);
		const ui = scriptedUi({ interactive: true, select: ["side"] });
		c.ui = ui;
		c.argv = ["--no-browser"];
		expect(await loginCommand.run(c)).toBe(0);
		expect(ui.events).toContain("select: Default organization for this login?");
		const saved = accounts(c);
		expect(saved.default).toBe("default");
		expect(saved.accounts.default).toMatchObject({ organizationId: "o2", token: "sess_tok" });
		expect(saved.accounts.acme).toMatchObject({ organizationId: "o1", token: "sess_tok" });
		expect(saved.accounts.side).toBeUndefined();
		expect(server.calls.some((x) => x.body?.organizationId === "o2")).toBe(true);
		const err = c.stderr.join("\n");
		expect(err).toContain("organization: Side (side)");
		expect(err).toContain("acme → --account acme");
	});

	test("several orgs, cancelled prompt: nothing saved, exit 1", async () => {
		const c = setup(fakeServer({ me: noActive, orgs: [acme, side] }));
		c.ui = scriptedUi({ interactive: true, select: [undefined] });
		c.argv = ["--no-browser"];
		expect(await loginCommand.run(c)).toBe(1);
		expect(readCredentials(c.env)).toEqual({ success: true, data: undefined });
	});

	test("several orgs, non-interactive: the session's active org is the default", async () => {
		const c = setup(fakeServer({ orgs: [side, acme] }));
		c.argv = ["--json"];
		expect(await loginCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({
			organization: acme,
			profiles: [{ account: "side", organization: side }],
		});
		expect(accounts(c).accounts.side).toMatchObject({ organizationId: "o2" });
	});

	test("several orgs, non-interactive, none active: the first one", async () => {
		const c = setup(fakeServer({ me: noActive, orgs: [side, acme] }));
		c.argv = ["--json"];
		expect(await loginCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).organization).toEqual(side);
	});

	test("--org picks the default without asking; unknown --org fails", async () => {
		const c = setup(fakeServer({ orgs: [acme, side] }));
		const ui = scriptedUi({ interactive: true });
		c.ui = ui;
		c.argv = ["--no-browser", "--org", "side"];
		expect(await loginCommand.run(c)).toBe(0);
		expect(ui.events.some((e) => e.startsWith("select:"))).toBe(false);
		expect(accounts(c).accounts.default?.organizationId).toBe("o2");

		const d = setup(fakeServer({ orgs: [acme, side] }));
		d.argv = ["--org", "nope"];
		expect(await loginCommand.run(d)).toBe(1);
		expect(d.stderr.join("\n")).toContain("not a member of nope");
		expect(readCredentials(d.env)).toEqual({ success: true, data: undefined });
	});

	test("never overwrites an account of another user; refreshes its own", async () => {
		const first = setup(fakeServer({ orgs: [acme, side] }));
		first.argv = ["--account", "side"];
		expect(await loginCommand.run(first)).toBe(0);

		const server = fakeServer({ orgs: [acme, side] });
		server.me = { ...server.me, user: { id: "u2", email: "other@acme.test" } };
		server.token = "tok_2";
		first.fetch = server.fetch;
		first.argv = ["--account", "work"];
		first.stderr.length = 0;
		expect(await loginCommand.run(first)).toBe(0);
		const saved = accounts(first);
		expect(saved.accounts.side?.user.email).toBe("dev@acme.test");
		expect(saved.accounts.work).toMatchObject({ token: "tok_2", organizationId: "o1" });
		expect(first.stderr.join("\n")).toContain("account side belongs to dev@acme.test");
	});

	test("logout of one profile keeps the shared session for the others", async () => {
		const server = fakeServer({ orgs: [acme, side] });
		const c = setup(server);
		expect(await loginCommand.run(c)).toBe(0);
		c.argv = ["--account", "side", "--json"];
		c.stdout.length = 0;
		expect(await logoutCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({
			loggedOut: true,
			revoked: false,
			kept: true,
			accounts: ["side"],
		});
		expect(server.calls.some((x) => x.path === "/api/auth/sign-out")).toBe(false);
		c.argv = ["--account", "default", "--json"];
		c.stdout.length = 0;
		expect(await logoutCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ revoked: true, kept: false });
		expect(server.calls.at(-1)?.path).toBe("/api/auth/sign-out");
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
		const server = fakeServer({ orgs: [{ id: "o1", name: "Acme", slug: "acme" }] });
		const c = await loggedIn(server);
		c.argv = ["--json"];
		expect(await logoutCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({
			loggedOut: true,
			revoked: true,
			kept: false,
			accounts: ["default"],
		});
		expect(server.calls.at(-1)?.path).toBe("/api/auth/sign-out");
		expect(readCredentials(c.env)).toEqual({ success: true, data: undefined });
	});
});

describe("warden login: no organization yet", () => {
	const noOrg = { user: { id: "u1", email: "dev@acme.test" }, organization: null, remote: null };

	test("interactive: creates one right there and saves the login with it", async () => {
		const server = fakeServer({ me: noOrg, orgs: [] });
		const c = setup(server);
		const ui = scriptedUi({ interactive: true, text: ["Acme Mobile", "acme-mobile"] });
		c.ui = ui;
		c.argv = ["--no-browser"];
		expect(await loginCommand.run(c)).toBe(0);
		expect(ui.events).toContain("text: Organization name?");
		expect(ui.events).toContain("text: Slug? [acme-mobile]");
		const saved = readAccounts(c.env);
		expect(saved.success && saved.data?.accounts.default?.organizationId).toBe("o1");
		expect(c.stderr.join("\n")).toContain("organization: Acme Mobile (acme-mobile)");
	});

	test("interactive, prompt cancelled: still logged in, told how to create one later", async () => {
		const c = setup(fakeServer({ me: noOrg, orgs: [] }));
		c.ui = scriptedUi({ interactive: true, text: [undefined] });
		c.argv = ["--no-browser"];
		expect(await loginCommand.run(c)).toBe(0);
		expect(readCredentials(c.env)).toMatchObject({ success: true, data: { token: "sess_tok" } });
		expect(c.stderr.join("\n")).toContain("warden org create");
	});

	test("non-interactive: no prompt, points at warden org create", async () => {
		const server = fakeServer({ me: noOrg, orgs: [] });
		const c = setup(server);
		expect(await loginCommand.run(c)).toBe(0);
		expect(server.calls.some((x) => x.path === "/api/auth/organization/create")).toBe(false);
		expect(c.stderr.join("\n")).toContain("warden org create <name>");
	});
});
