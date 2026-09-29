import { afterEach, describe, expect, test } from "bun:test";
import type { Lease, Owner } from "@warden/core/types";
import { type TestContext, testContext } from "../testing";
import { portCommand } from "./port";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const SESSION = "sess-1";
const other: Owner = { kind: "agent", sessionId: "someone-else", cwd: "/x" };

function make(argv: string[], session: string = SESSION): TestContext {
	ctx?.cleanup();
	const c = testContext(argv);
	c.env.WARDEN_SESSION_ID = session;
	ctx = c;
	return c;
}

/** Run `warden port …` against the same store as `base` (fresh output buffers). */
async function run(argv: string[], base?: TestContext, session: string = SESSION) {
	const c = base ?? make(argv, session);
	c.argv = argv;
	c.env.WARDEN_SESSION_ID = session;
	c.stdout.length = 0;
	c.stderr.length = 0;
	const code = await portCommand.run(c);
	return { code, c };
}

function ports(c: TestContext): number[] {
	return c.db.listLeases().flatMap((l) => (l.resource.kind === "port" ? [l.resource.port] : []));
}

// High, unusual range so real bind probes almost never collide with local services.
const FROM = "47310";

describe("warden port claim", () => {
	test("prints the claimed port and leases it for the agent session", async () => {
		const { code, c } = await run(["claim", "--from", FROM, "--span", "20", "--label", "metro"]);
		expect(code).toBe(0);
		const port = Number(c.stdout[0]);
		expect(port).toBeGreaterThanOrEqual(47310);
		expect(port).toBeLessThan(47330);
		const [lease] = c.db.listLeases();
		expect(lease?.owner).toMatchObject({ kind: "agent", sessionId: SESSION });
		expect(lease?.label).toBe("metro");
		expect(lease?.ttlMs).toBe(30 * 60_000);
		expect(lease?.pid).toBeUndefined();
	});

	test("--count + --ttl + --json", async () => {
		const { code, c } = await run(["claim", "--from", FROM, "--count", "2", "--ttl", "5m", "--json"]);
		expect(code).toBe(0);
		const leases = JSON.parse(c.stdout.join("\n")) as Lease[];
		expect(leases).toHaveLength(2);
		expect(leases.every((l) => l.ttlMs === 300_000)).toBe(true);
		expect(new Set(leases.map((l) => (l.resource.kind === "port" ? l.resource.port : 0))).size).toBe(2);
	});

	test("second claim skips the first claim's port", async () => {
		const first = await run(["claim", "--from", FROM]);
		await run(["claim", "--from", FROM], first.c);
		expect(new Set(ports(first.c)).size).toBe(2);
	});

	test("user owner (no session) leases with pid = owner pid", async () => {
		const c = testContext(["claim", "--from", FROM]);
		ctx = c;
		expect(await portCommand.run(c)).toBe(0);
		const [lease] = c.db.listLeases();
		expect(lease?.owner.kind).toBe("user");
		expect(lease?.owner.kind === "user" && lease.pid).toBe(process.ppid);
	});

	test("bad flags → exit 1", async () => {
		expect((await run(["claim", "--from", "0"])).code).toBe(1);
		expect((await run(["claim", "--ttl", "soon"])).code).toBe(1);
		expect((await run(["claim", "--count", "x"])).code).toBe(1);
	});

	test("exhausted range → exit 1 with message", async () => {
		const c = make([]);
		c.db.insertLease({ resource: { kind: "port", port: 47310 }, owner: other, ttlMs: 60 * 60_000 }, c.now());
		const { code } = await run(["claim", "--from", FROM, "--span", "1"], c);
		expect(code).toBe(1);
		expect(c.stderr.join("\n")).toContain("no free port in 47310–47310");
	});
});

describe("warden port release", () => {
	test("by port, only own leases unless --force", async () => {
		const c = make([]);
		const mineRes = await run(["claim", "--from", FROM], c);
		const mine = Number(mineRes.c.stdout[0]);
		c.db.insertLease({ resource: { kind: "port", port: 47399 }, owner: other, ttlMs: 60_000 }, c.now());

		const denied = await run(["release", String(mine), "47399"], c);
		expect(denied.code).toBe(1);
		expect(c.stderr.join("\n")).toContain("47399");
		expect(ports(c)).toEqual([47399]);

		const forced = await run(["release", "47399", "--force", "--json"], c);
		expect(forced.code).toBe(0);
		expect(JSON.parse(c.stdout.join("\n")).released).toHaveLength(1);
		expect(ports(c)).toEqual([]);
	});

	test("--lease takes several ids", async () => {
		const c = make([]);
		await run(["claim", "--from", FROM, "--count", "3"], c);
		const [a, b] = c.db.listLeases();
		expect((await run(["release", "--lease", a?.id ?? "", b?.id ?? ""], c)).code).toBe(0);
		expect(ports(c)).toHaveLength(1);
	});

	test("--lease ids and --mine", async () => {
		const c = make([]);
		await run(["claim", "--from", FROM, "--count", "3"], c);
		const [first] = c.db.listLeases();
		const byId = await run(["release", "--lease", first?.id ?? ""], c);
		expect(byId.code).toBe(0);
		expect(ports(c)).toHaveLength(2);
		c.db.insertLease({ resource: { kind: "port", port: 47399 }, owner: other, ttlMs: 60_000 }, c.now());
		const mine = await run(["release", "--mine"], c);
		expect(mine.code).toBe(0);
		expect(ports(c)).toEqual([47399]);
	});

	test("nothing selected → usage error", async () => {
		expect((await run(["release"])).code).toBe(1);
	});

	test("unknown port → exit 1", async () => {
		const { code, c } = await run(["release", "47311"]);
		expect(code).toBe(1);
		expect(c.stderr.join("\n")).toContain("47311");
	});
});

describe("warden port ls", () => {
	test("table and json", async () => {
		const c = make([]);
		c.db.insertLease(
			{ resource: { kind: "port", port: 8091 }, owner: other, ttlMs: 60_000, label: "metro" },
			c.now() - 5_000
		);
		c.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "U", name: "sim" }, owner: other, ttlMs: 60_000 },
			c.now()
		);
		const table = await run(["ls"], c);
		expect(table.code).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).toContain("PORT");
		expect(text).toContain("8091");
		expect(text).toContain("metro");
		expect(text).toContain("someone-else");
		expect(text).not.toContain("sim");

		await run(["ls", "--json"], c);
		const leases = JSON.parse(c.stdout.join("\n")) as Lease[];
		expect(leases.map((l) => l.resource)).toEqual([{ kind: "port", port: 8091 }]);
	});

	test("empty", async () => {
		const { code, c } = await run(["ls"]);
		expect(code).toBe(0);
		expect(c.stdout.join("\n")).toContain("no port leases");
	});
});

describe("warden port (usage)", () => {
	test("no subcommand → help on stderr, exit 1", async () => {
		const { code, c } = await run([]);
		expect(code).toBe(1);
		const help = c.stderr.join("\n");
		expect(help).toContain("claim");
		expect(help).toContain("release");
		expect(help).toContain("ls");
	});

	test("unknown subcommand / option → commander usage error, exit 1", async () => {
		const unknown = await run(["nope"]);
		expect(unknown.code).toBe(1);
		expect(unknown.c.stderr.join("\n")).toContain("unknown command 'nope'");
		const bogus = await run(["ls", "--bogus"]);
		expect(bogus.code).toBe(1);
		expect(bogus.c.stderr.join("\n")).toContain("unknown option '--bogus'");
	});

	test("--help → exit 0, stdout lists the subcommand's options", async () => {
		const { code, c } = await run(["release", "--help"]);
		expect(code).toBe(0);
		expect(c.stdout.join("\n")).toContain("--lease <id...>");
	});
});
