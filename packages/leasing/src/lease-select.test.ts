import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@delacour/warden-store/types";
import { isEmptySelector, type LeaseSelector, selectLeases } from "./lease-select";
import { type TestLeaseHost, testLeaseHost } from "./testing/lease-host.testing";

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
		expect(isEmptySelector(none)).toBe(true);
		expect(isEmptySelector({ ...none, ids: ["l"] })).toBe(false);
		expect(isEmptySelector({ ...none, mine: true })).toBe(false);
		expect(isEmptySelector({ ...none, session: "s" })).toBe(false);
	});
});

describe("selectLeases", () => {
	test("ids and udids resolve, deduplicated; unknown ones are reported", () => {
		host = testLeaseHost();
		const a = lease(host, "U1", alice);
		const result = selectLeases(host, { ...none, ids: [a.id, "nope"], udids: ["U1", "U2"] });
		expect(result.leases.map((l) => l.id)).toEqual([a.id]);
		expect(result.unknown).toEqual(["nope", "U2"]);
	});

	test("--mine takes the caller's leases (optionally by label); --session another agent's", () => {
		host = testLeaseHost();
		host.env = { ...host.env, WARDEN_SESSION_ID: "alice" };
		const a1 = lease(host, "U1", alice, "x");
		lease(host, "U2", alice, "y");
		const b = lease(host, "U3", bob);
		expect(selectLeases(host, { ...none, mine: true, label: "x" }).leases.map((l) => l.id)).toEqual([a1.id]);
		expect(selectLeases(host, { ...none, session: "bob" }).leases.map((l) => l.id)).toEqual([b.id]);
	});
});
