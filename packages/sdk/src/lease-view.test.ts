import { expect, test } from "bun:test";
import type { Lease } from "@delacour/warden-store/types";
import { aliveDeviceLeases, withLeaseState } from "./lease-view";

const owner = { kind: "ci", runId: "r" } as const;
const device = (id: string, heartbeatAt: number): Lease => ({
	id: `l_${id}`,
	resource: { kind: "device", platform: "ios", id, name: id },
	owner,
	acquiredAt: 0,
	heartbeatAt,
	ttlMs: 1000,
});
const port: Lease = {
	id: "l_p",
	resource: { kind: "port", port: 8081 },
	owner,
	acquiredAt: 0,
	heartbeatAt: 5000,
	ttlMs: 1000,
};
const never = () => false;

test("withLeaseState marks each lease alive or stale", () => {
	const rows = withLeaseState([device("a", 4500), device("b", 0)], 5000, never);
	expect(rows.map((r) => [r.id, r.state])).toEqual([
		["l_a", "alive"],
		["l_b", "stale"],
	]);
});

test("aliveDeviceLeases keys live device leases by platform:id and skips ports and stale leases", () => {
	const map = aliveDeviceLeases([device("a", 4500), device("b", 0), port], 5000, never);
	expect([...map.keys()]).toEqual(["ios:a"]);
});
