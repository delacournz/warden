import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, ownerKey, type Store } from "../store";
import { describeOwner, ownerLocation, sameOwner } from "../types";
import {
	deleteGrant,
	deleteHost,
	getGrant,
	getHost,
	type HostRecord,
	listGrants,
	listHosts,
	parseHostOwner,
	putGrant,
	putHost,
} from "./registry";

let dir: string;
let store: Store;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-hosts-"));
	store = openStore(join(dir, "warden.db"));
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const loop: HostRecord = {
	name: "loop",
	ssh: { user: "me", hostname: "127.0.0.1", port: 2222 },
	identity: "/k/id",
	addedAt: 5,
};

describe("host owner", () => {
	const a = { kind: "host", machineId: "m1", user: "chris" } as const;
	test("its owner key is the machine id, so the per-owner limit counts per laptop", () => {
		expect(ownerKey(a)).toBe("host:m1");
		expect(ownerKey({ ...a, user: "someone" })).toBe("host:m1");
	});
	test("same machine = same owner; never the same as an agent or user", () => {
		expect(sameOwner(a, { ...a })).toBe(true);
		expect(sameOwner(a, { ...a, machineId: "m2" })).toBe(false);
		expect(sameOwner(a, { kind: "agent", sessionId: "m1", cwd: "/" })).toBe(false);
	});
	test("described by user and machine, no location", () => {
		expect(describeOwner(a)).toBe("host chris@m1");
		expect(ownerLocation(a)).toBeUndefined();
	});
	test("parseHostOwner reads the env value __host-serve sets, and nothing else", () => {
		expect(parseHostOwner('{"machineId":"m1","user":"chris"}')).toEqual(a);
		expect(parseHostOwner(undefined)).toBeUndefined();
		expect(parseHostOwner("nope")).toBeUndefined();
		expect(parseHostOwner('{"machineId":"","user":"x"}')).toBeUndefined();
		expect(parseHostOwner('{"machineId":"m 1","user":"x"}')).toBeUndefined();
	});
});

describe("hosts", () => {
	test("put, get, list, replace, delete", () => {
		putHost(store, loop);
		putHost(store, { ...loop, name: "b", proxyCommand: "cloudflared access ssh --hostname %h", jump: "bastion" });
		expect(getHost(store, "loop")).toEqual(loop);
		expect(listHosts(store).map((h) => h.name)).toEqual(["b", "loop"]);
		putHost(store, { ...loop, version: "0.9.0" });
		expect(getHost(store, "loop")?.version).toBe("0.9.0");
		expect(getHost(store, "b")?.jump).toBe("bastion");
		expect(deleteHost(store, "loop")).toBe(true);
		expect(deleteHost(store, "loop")).toBe(false);
		expect(getHost(store, "loop")).toBeUndefined();
	});
});

describe("grants", () => {
	test("keyed by fingerprint; delete returns whether one was there", () => {
		const grant = {
			fingerprint: "SHA256:abc",
			machineId: "m1",
			user: "chris",
			publicKey: "ssh-ed25519 AAA c",
			addedAt: 1,
		};
		putGrant(store, grant);
		expect(getGrant(store, "SHA256:abc")).toEqual(grant);
		expect(listGrants(store)).toEqual([grant]);
		expect(deleteGrant(store, "SHA256:abc")).toBe(true);
		expect(getGrant(store, "SHA256:abc")).toBeUndefined();
	});
});
