import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fakeServer } from "../remote/api.testing";
import { readAccounts } from "../remote/credentials";
import { upsertLink } from "../remote/links";
import { fakeExec, type TestContext, testContext } from "../testing";
import { accountCommand } from "./account";
import { loginCommand } from "./login";
import { logoutCommand } from "./logout";
import { whoamiCommand } from "./whoami";

let ctx: TestContext | undefined;
let current = fakeServer();
afterEach(() => ctx?.cleanup());

function setup(server = fakeServer()): TestContext {
	current = server;
	ctx = testContext([], { fetch: server.fetch, sleep: async () => {}, exec: fakeExec([["open", {}]]) });
	ctx.env = { ...ctx.env, WARDEN_API_URL: "https://api.test" };
	return ctx;
}

/** Each device flow consumes the server's scripted polls, so every login gets a fresh approval. */
async function login(c: TestContext, ...args: string[]): Promise<void> {
	current.polls.push("approve");
	c.argv = args;
	expect(await loginCommand.run(c)).toBe(0);
	c.stdout.length = 0;
	c.stderr.length = 0;
}

describe("warden login --account", () => {
	test("first login is the default account; --account adds another without moving the default", async () => {
		const c = setup();
		await login(c);
		await login(c, "--account", "work");
		const saved = readAccounts(c.env);
		expect(saved.success && saved.data?.default).toBe("default");
		expect(saved.success && Object.keys(saved.data?.accounts ?? {}).sort()).toEqual(["default", "work"]);
	});

	test("the first login ever, even with --account, becomes the default", async () => {
		const c = setup();
		await login(c, "--account", "work");
		const saved = readAccounts(c.env);
		expect(saved.success && saved.data?.default).toBe("work");
	});

	test("--json names the account", async () => {
		const c = setup();
		c.argv = ["--account", "work", "--json"];
		expect(await loginCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).account).toBe("work");
	});

	test("an invalid name is refused before the device flow starts", async () => {
		const server = fakeServer();
		const c = setup(server);
		c.argv = ["--account", "Bad Name"];
		expect(await loginCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("account name");
		expect(server.calls).toEqual([]);
	});
});

describe("warden account", () => {
	test("list marks the default and the one this directory uses", async () => {
		const c = setup();
		await login(c);
		await login(c, "--account", "work");
		c.argv = ["list", "--json"];
		expect(await accountCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual([
			expect.objectContaining({ name: "default", default: true, active: true, email: "dev@acme.test" }),
			expect.objectContaining({ name: "work", default: false, active: false }),
		]);
	});

	test("default switches the default account; unknown name fails", async () => {
		const c = setup();
		await login(c);
		await login(c, "--account", "work");
		c.argv = ["default", "work"];
		expect(await accountCommand.run(c)).toBe(0);
		const saved = readAccounts(c.env);
		expect(saved.success && saved.data?.default).toBe("work");
		c.argv = ["default", "nope"];
		expect(await accountCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("no account nope");
	});

	test("rm revokes and forgets one account", async () => {
		const server = fakeServer();
		const c = setup(server);
		await login(c);
		await login(c, "--account", "work");
		c.argv = ["rm", "work"];
		expect(await accountCommand.run(c)).toBe(0);
		expect(server.calls.at(-1)?.path).toBe("/api/auth/sign-out");
		const saved = readAccounts(c.env);
		expect(saved.success && Object.keys(saved.data?.accounts ?? {})).toEqual(["default"]);
	});
});

describe("warden logout", () => {
	test("--account logs out of that one only", async () => {
		const c = setup();
		await login(c);
		await login(c, "--account", "work");
		c.argv = ["--account", "work", "--json"];
		expect(await logoutCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({ loggedOut: true, revoked: true, accounts: ["work"] });
		const saved = readAccounts(c.env);
		expect(saved.success && Object.keys(saved.data?.accounts ?? {})).toEqual(["default"]);
	});

	test("--all logs out of every account", async () => {
		const c = setup();
		await login(c);
		await login(c, "--account", "work");
		c.argv = ["--all", "--json"];
		expect(await logoutCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ loggedOut: true, accounts: ["default", "work"] });
		expect(readAccounts(c.env)).toEqual({ success: true, data: undefined });
	});

	test("--account naming no account is a note, not an error", async () => {
		const c = setup();
		await login(c);
		c.argv = ["--account", "nope", "--json"];
		expect(await logoutCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({ loggedOut: false, revoked: false, accounts: [] });
	});
});

describe("warden whoami with links", () => {
	test("a linked directory uses the link's account and sends its org", async () => {
		const server = fakeServer();
		const c = setup(server);
		await login(c);
		await login(c, "--account", "work");
		const linked = realpathSync(c.cwd);
		const sub = join(linked, "worktree", "src");
		mkdirSync(sub, { recursive: true });
		upsertLink(c.env, {
			kind: "path",
			path: linked,
			account: "work",
			organizationId: "o2",
			orgSlug: "side",
			createdAt: 1,
		});
		c.cwd = sub;
		c.argv = ["--json"];
		expect(await whoamiCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({
			account: "work",
			accountVia: "link",
			orgVia: "link",
			link: { kind: "path", path: linked },
		});
		expect(server.calls.at(-1)?.organization).toBe("o2");

		c.stdout.length = 0;
		c.argv = [];
		expect(await whoamiCommand.run(c)).toBe(0);
		expect(c.stdout.join("\n")).toContain(`work  via ${linked}`);
	});
});
