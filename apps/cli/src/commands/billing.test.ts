import { afterEach, describe, expect, test } from "bun:test";
import { type FakeServer, fakeServer } from "../remote/api.testing";
import { fakeExec, scriptedUi, type TestContext, testContext } from "../testing";
import { billingCommand } from "./billing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function setup(argv: string[], server: FakeServer = fakeServer(), calls: string[][] = []): TestContext {
	ctx = testContext(argv, { fetch: server.fetch, os: "darwin", exec: fakeExec([["open", {}]], calls) });
	ctx.env = { ...ctx.env, WARDEN_API_URL: "https://api.test", WARDEN_TOKEN: server.token };
	return ctx;
}

describe("warden billing", () => {
	test("shows the balance, minutes left, trial and the ledger tail", async () => {
		const c = setup([]);
		expect(await billingCommand.run(c)).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).toContain("$1.60");
		expect(text).toContain("~8 min left at $0.20/min");
		expect(text).toContain("active ($2.00)");
		expect(text).toContain("usage");
		expect(text).toContain("-$0.40");
		expect(text).toContain("grant");
		expect(text).toContain("https://app.warden.test/billing");
	});

	test("--json: billing plus ledger entries, honouring --limit", async () => {
		const server = fakeServer();
		const c = setup(["--json", "--limit", "1"], server);
		expect(await billingCommand.run(c)).toBe(0);
		const out = JSON.parse(c.stdout.join("\n"));
		expect(out.billing).toMatchObject({ balanceUsd: 1.6, trial: { state: "active" } });
		expect(out.ledger).toEqual([{ id: "l2", kind: "usage", amountUsd: -0.4, createdAt: "2026-10-30T00:02:00.000Z" }]);
		expect(server.calls.find((x) => x.path === "/v1/billing/ledger")).toBeDefined();
	});

	test("--top-up 20 creates a checkout and opens it", async () => {
		const server = fakeServer();
		const calls: string[][] = [];
		const c = setup(["--top-up", "20", "--json"], server, calls);
		c.ui = scriptedUi({ interactive: true });
		expect(await billingCommand.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({
			amountUsd: 20,
			checkoutUrl: "https://checkout.stripe.test/pay/cs_20",
			opened: true,
		});
		expect(server.calls.find((x) => x.path === "/v1/billing/topups")?.body).toEqual({ amountUsd: 20 });
		expect(calls).toEqual([["open", "https://checkout.stripe.test/pay/cs_20"]]);
	});

	test("--top-up --no-browser prints the link instead", async () => {
		const calls: string[][] = [];
		const c = setup(["--top-up", "50", "--no-browser"], fakeServer(), calls);
		c.ui = scriptedUi({ interactive: true });
		expect(await billingCommand.run(c)).toBe(0);
		expect(calls).toEqual([]);
		expect(c.stdout.join("\n")).toContain("https://checkout.stripe.test/pay/cs_50");
	});

	test("--top-up with no amount picks one interactively", async () => {
		const server = fakeServer();
		const c = setup(["--top-up", "--no-browser"], server);
		c.ui = scriptedUi({ interactive: true, select: ["50"] });
		expect(await billingCommand.run(c)).toBe(0);
		expect(server.calls.find((x) => x.path === "/v1/billing/topups")?.body).toEqual({ amountUsd: 50 });
	});

	test("--top-up with no amount and no terminal names the flag", async () => {
		const server = fakeServer();
		const c = setup(["--top-up"], server);
		expect(await billingCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("warden billing --top-up <amount>");
		expect(server.calls.find((x) => x.path === "/v1/billing/topups")).toBeUndefined();
	});

	test("amounts outside $10–$500 or with fractions of a cent are refused locally", async () => {
		for (const amount of ["5", "501", "12.345", "ten"]) {
			const server = fakeServer();
			const c = setup(["--top-up", amount], server);
			expect(await billingCommand.run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain("$10 and $500");
			expect(server.calls.find((x) => x.path === "/v1/billing/topups")).toBeUndefined();
			c.cleanup();
		}
		ctx = undefined;
	});

	test("a member gets billing_role in the JSON failure", async () => {
		const server = fakeServer();
		server.topupError = { status: 403, body: { success: false, code: "BILLING_ROLE", error: "owners only" } };
		const c = setup(["--top-up", "20", "--json"], server);
		expect(await billingCommand.run(c)).toBe(1);
		expect(JSON.parse(c.stdout.join("\n")).error).toMatchObject({ code: "billing_role" });
	});

	test("not logged in → the login hint", async () => {
		const c = setup([]);
		c.env = { ...c.env, WARDEN_TOKEN: undefined };
		expect(await billingCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("warden login");
	});
});
