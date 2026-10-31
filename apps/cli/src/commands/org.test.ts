import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeServer, fakeServer } from "../remote/api.testing";
import { readAccounts, writeAccount } from "../remote/credentials";
import { readLinks, upsertLink } from "../remote/links";
import { authedApi } from "../remote/session";
import { fakeExec, scriptedUi, type TestContext, testContext } from "../testing";
import { claimCommand } from "./claim";
import { orgCommand } from "./org";

let ctx: TestContext | undefined;
let scratch: string | undefined;
afterEach(() => {
	ctx?.cleanup();
	ctx = undefined;
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = undefined;
});

function repoDirs(): { repo: string; sub: string } {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "warden-org-")));
	const repo = join(scratch, "repo");
	const sub = join(repo, "packages", "app");
	mkdirSync(sub, { recursive: true });
	return { repo, sub };
}

function seed(c: TestContext, server: FakeServer, name = "work", organizationId = "o1"): void {
	const saved = writeAccount(c.env, name, {
		apiUrl: "https://api.test",
		token: server.token,
		user: { id: "u1", email: `${name}@acme.test` },
		organizationId,
		savedAt: 1,
	});
	expect(saved.success).toBe(true);
}

function setup(server: FakeServer, overrides: Parameters<typeof testContext>[1] = {}): TestContext {
	ctx = testContext([], { fetch: server.fetch, sleep: async () => {}, ...overrides });
	ctx.env = { ...ctx.env, WARDEN_API_URL: "https://api.test" };
	seed(ctx, server);
	return ctx;
}

function run(c: TestContext, ...argv: string[]): Promise<number> {
	c.argv = argv;
	c.stdout.length = 0;
	c.stderr.length = 0;
	return orgCommand.run(c);
}

const stdoutJson = (c: TestContext): unknown => JSON.parse(c.stdout.join("\n"));

describe("warden org list", () => {
	test("marks the effective org, which a link can override", async () => {
		const server = fakeServer();
		const c = setup(server);
		expect(await run(c, "list", "--json")).toBe(0);
		expect(stdoutJson(c)).toEqual([
			{ id: "o1", name: "Acme", slug: "acme", active: true },
			{ id: "o2", name: "Side", slug: "side", active: false },
		]);
		upsertLink(c.env, {
			kind: "path",
			path: realpathSync(c.cwd),
			account: "work",
			organizationId: "o2",
			orgSlug: "side",
			createdAt: 1,
		});
		expect(await run(c, "list", "--json")).toBe(0);
		expect(stdoutJson(c)).toMatchObject([{ active: false }, { id: "o2", active: true }]);
	});

	test("marks nothing when no org resolves", async () => {
		const server = fakeServer();
		const c = setup(server);
		const accounts = readAccounts(c.env);
		if (!accounts.success || !accounts.data) throw new Error("no accounts");
		const { organizationId: _drop, ...bare } = accounts.data.accounts.work ?? ({} as never);
		writeAccount(c.env, "work", bare as never);
		expect(await run(c, "list", "--json")).toBe(0);
		expect(stdoutJson(c)).toMatchObject([{ active: false }, { active: false }]);
	});
});

describe("warden org use", () => {
	test("switches the org and saves it on the resolved account", async () => {
		const server = fakeServer();
		const c = setup(server);
		expect(await run(c, "use", "side")).toBe(0);
		expect(server.calls.at(-1)).toMatchObject({
			path: "/api/auth/organization/set-active",
			body: { organizationId: "o2" },
		});
		const accounts = readAccounts(c.env);
		expect(accounts.success && accounts.data?.accounts.work?.organizationId).toBe("o2");
		expect(await run(c, "use", "nope")).toBe(1);
	});

	test("--account targets another saved account", async () => {
		const server = fakeServer();
		const c = setup(server);
		seed(c, server, "personal", "o1");
		expect(await run(c, "use", "side", "--account", "personal")).toBe(0);
		const accounts = readAccounts(c.env);
		if (!accounts.success || !accounts.data) throw new Error("no accounts");
		expect(accounts.data.accounts.personal?.organizationId).toBe("o2");
		expect(accounts.data.accounts.work?.organizationId).toBe("o1");
		expect(await run(c, "use", "side", "--account", "ghost")).toBe(1);
		expect(c.stderr.join("\n")).toContain("ghost");
	});
});

describe("warden org link / unlink / links", () => {
	test("link defaults to the git toplevel, and later commands in a subdir send the linked org", async () => {
		const server = fakeServer();
		const { repo, sub } = repoDirs();
		const c = setup(server);
		c.cwd = sub;
		c.git.store(sub, { toplevel: repo, commonDir: join(repo, ".git"), branch: "main" });
		expect(await run(c, "link", "side")).toBe(0);
		expect(c.stderr.join("\n") + c.stdout.join("\n")).toContain(`linked ${repo} → Side (side) as work`);
		expect(readLinks(c.env)).toMatchObject({
			success: true,
			data: [{ kind: "path", path: repo, account: "work", organizationId: "o2", orgSlug: "side" }],
		});

		const authed = authedApi(c);
		expect(authed.success && authed.data.organization).toBe("o2");
		server.calls.length = 0;
		expect(await run(c, "list", "--json")).toBe(0);
		expect(server.calls.every((call) => call.organization === "o2")).toBe(true);
		expect(stdoutJson(c)).toMatchObject([{ active: false }, { id: "o2", active: true }]);
	});

	test("link falls back to cwd outside git, honours --path, and --json prints the link", async () => {
		const server = fakeServer();
		const { repo } = repoDirs();
		const c = setup(server);
		expect(await run(c, "link", "acme", "--path", `${repo}/`, "--json")).toBe(0);
		expect(stdoutJson(c)).toMatchObject({ kind: "path", path: repo, orgSlug: "acme", organizationId: "o1" });
		expect(await run(c, "link", "o2")).toBe(0);
		const links = readLinks(c.env);
		expect(links.success && links.data.map((l) => l.kind === "path" && l.path).sort()).toEqual(
			[realpathSync(c.cwd), repo].sort()
		);
	});

	test("link --remote uses the normalized origin", async () => {
		const server = fakeServer();
		const c = setup(server, {
			exec: fakeExec([["git remote get-url origin", { stdout: "git@GitHub.com:a/b.git\n" }]]),
		});
		expect(await run(c, "link", "side", "--remote")).toBe(0);
		expect(readLinks(c.env)).toMatchObject({ data: [{ kind: "remote", remote: "github.com/a/b", orgSlug: "side" }] });
	});

	test("link --remote without an origin fails", async () => {
		const c = setup(fakeServer(), { exec: fakeExec([["git remote get-url origin", { exitCode: 2 }]]) });
		expect(await run(c, "link", "side", "--remote")).toBe(1);
		expect(c.stderr.join("\n")).toContain("origin");
	});

	test("link rejects an org the account is not a member of", async () => {
		const c = setup(fakeServer());
		expect(await run(c, "link", "stranger")).toBe(1);
		expect(c.stderr.join("\n")).toContain("not a member of stranger (warden org list --account work)");
		expect(readLinks(c.env)).toEqual({ success: true, data: [] });
	});

	test("link needs a saved account, not WARDEN_TOKEN", async () => {
		const server = fakeServer();
		ctx = testContext([], { fetch: server.fetch });
		ctx.env = { ...ctx.env, WARDEN_API_URL: "https://api.test", WARDEN_TOKEN: server.token };
		expect(await run(ctx, "link", "acme")).toBe(1);
		expect(ctx.stderr.join("\n")).toContain("org link needs a saved account (warden login)");
	});

	test("link --account links for that account", async () => {
		const server = fakeServer();
		const c = setup(server);
		seed(c, server, "personal", "o1");
		expect(await run(c, "link", "side", "--account", "personal")).toBe(0);
		expect(readLinks(c.env)).toMatchObject({ data: [{ account: "personal", orgSlug: "side" }] });
	});

	test("no org argument: interactive picks from a list, cancel aborts", async () => {
		const server = fakeServer();
		const c = setup(server, { ui: scriptedUi({ interactive: true, select: ["side", undefined] }) });
		expect(await run(c, "link")).toBe(0);
		expect(readLinks(c.env)).toMatchObject({ data: [{ orgSlug: "side" }] });
		expect(await run(c, "link")).toBe(1);
		const events = (c.ui as ReturnType<typeof scriptedUi>).events;
		expect(events.some((e) => e.startsWith("select:"))).toBe(true);
		expect(events).toContain("cancelled: Aborted.");
	});

	test("no org argument: non-interactive and --json fail with the hint", async () => {
		const c = setup(fakeServer());
		expect(await run(c, "link")).toBe(1);
		expect(c.stderr.join("\n")).toContain("pass an organization: warden org link <org>");
		const interactive = setup(fakeServer(), { ui: scriptedUi({ interactive: true, select: ["side"] }) });
		expect(await run(interactive, "link", "--json")).toBe(1);
		expect(interactive.stderr.join("\n")).toContain("pass an organization");
	});

	test("unlink removes the link, a second unlink fails", async () => {
		const server = fakeServer();
		const { repo } = repoDirs();
		const c = setup(server);
		await run(c, "link", "side", "--path", repo);
		expect(await run(c, "unlink", "--path", repo)).toBe(0);
		expect(readLinks(c.env)).toEqual({ success: true, data: [] });
		expect(await run(c, "unlink", "--path", repo)).toBe(1);
		expect(c.stderr.join("\n")).toContain(`no link for ${repo} (warden org links)`);
	});

	test("unlink --remote", async () => {
		const server = fakeServer();
		const c = setup(server, {
			exec: fakeExec([["git remote get-url origin", { stdout: "https://github.com/a/b.git\n" }]]),
		});
		await run(c, "link", "side", "--remote");
		expect(await run(c, "unlink", "--remote", "--json")).toBe(0);
		expect(readLinks(c.env)).toEqual({ success: true, data: [] });
	});

	test("links marks the one matching cwd", async () => {
		const server = fakeServer();
		const { repo, sub } = repoDirs();
		const c = setup(server);
		await run(c, "link", "side", "--path", repo);
		await run(c, "link", "acme", "--path", join(repo, "elsewhere"));
		c.cwd = sub;
		expect(await run(c, "links", "--json")).toBe(0);
		const out = stdoutJson(c) as Array<{ path: string; active: boolean }>;
		expect(out.map((l) => [l.path, l.active])).toEqual(
			expect.arrayContaining([
				[repo, true],
				[join(repo, "elsewhere"), false],
			])
		);
		expect(await run(c, "links")).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).toContain("TARGET");
		expect(text).toMatch(new RegExp(`\\*\\s+${repo}\\s+side\\s+work`));
	});

	test("links with none prints a hint", async () => {
		const c = setup(fakeServer());
		expect(await run(c, "links")).toBe(0);
		expect(c.stdout.join("\n")).toContain("no links");
	});
});

describe("warden claim --remote billing note", () => {
	test("names the org, account and why", async () => {
		const server = fakeServer();
		const { repo } = repoDirs();
		const c = setup(server);
		await run(c, "link", "side", "--path", repo);
		c.cwd = repo;
		c.env = { ...c.env, WARDEN_SESSION_ID: "s1" };
		c.argv = ["ios", "--remote"];
		expect(await claimCommand.run(c)).toBe(0);
		expect(c.stderr.join("\n")).toContain(`billing o2 (work, via ${repo})`);
		expect(server.calls.find((call) => call.method === "POST" && call.path === "/v1/devices")?.organization).toBe("o2");
	});

	test("--json adds account, organization and via", async () => {
		const server = fakeServer();
		const c = setup(server);
		c.env = { ...c.env, WARDEN_SESSION_ID: "s1" };
		c.argv = ["ios", "--remote", "--json"];
		expect(await claimCommand.run(c)).toBe(0);
		expect(stdoutJson(c)).toMatchObject({ account: "work", organization: "o1", via: "account" });
	});
});
