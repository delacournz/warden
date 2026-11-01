import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@delacour/warden-store/types";
import { LeaseSelection, type LeaseSelector, leaseSelectorRules } from "./lease-select";
import { leaseHostFixture, type TestLeaseHost } from "./testing/lease-host.testing";

let host: TestLeaseHost | undefined;
afterEach(() => host?.cleanup());

const alice: Owner = { kind: "agent", sessionId: "alice", cwd: "/" };
const bob: Owner = { kind: "agent", sessionId: "bob", cwd: "/" };

function lease(h: TestLeaseHost, id: string, owner: Owner, label?: string) {
	return h.db.insertLease(
		{ resource: { kind: "device", platform: "ios", id, name: id }, owner, ttlMs: 60_000, ...(label ? { label } : {}) },
		h.now()
	);
}

const none: LeaseSelector = { ids: [], udids: [], mine: false };

describe("isEmptySelector", () => {
	test("nothing selected is empty; any selector part is not", () => {
		expect(leaseSelectorRules.isEmpty(none)).toBe(true);
		expect(leaseSelectorRules.isEmpty({ ...none, ids: ["l"] })).toBe(false);
		expect(leaseSelectorRules.isEmpty({ ...none, mine: true })).toBe(false);
		expect(leaseSelectorRules.isEmpty({ ...none, session: "s" })).toBe(false);
	});
});

describe("selectLeases", () => {
	test("ids and udids resolve, deduplicated; unknown ones are reported", () => {
		host = leaseHostFixture.build();
		const a = lease(host, "U1", alice);
		const result = new LeaseSelection(host).select({ ...none, ids: [a.id, "nope"], udids: ["U1", "U2"] });
		expect(result.leases.map((l) => l.id)).toEqual([a.id]);
		expect(result.unknown).toEqual(["nope", "U2"]);
	});

	test("--mine takes the caller's leases (optionally by label); --session another agent's", () => {
		host = leaseHostFixture.build();
		host.env = { ...host.env, WARDEN_SESSION_ID: "alice" };
		const a1 = lease(host, "U1", alice, "x");
		lease(host, "U2", alice, "y");
		const b = lease(host, "U3", bob);
		expect(new LeaseSelection(host).select({ ...none, mine: true, label: "x" }).leases.map((l) => l.id)).toEqual([
			a1.id,
		]);
		expect(new LeaseSelection(host).select({ ...none, session: "bob" }).leases.map((l) => l.id)).toEqual([b.id]);
	});
});
