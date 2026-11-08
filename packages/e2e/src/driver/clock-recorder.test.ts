import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeConditions } from "@delacour/warden-core/conditions/conditions";
import { openStore, type Store } from "@delacour/warden-core/store";
import { leaseClockRecorder } from "./clock-recorder";

let dir: string;
let store: Store;
let leaseId: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-clock-"));
	store = openStore(join(dir, "warden.db"));
	leaseId = store.insertLease(
		{
			resource: { kind: "device", platform: "ios", id: "U1", name: "sim" },
			owner: { kind: "agent", sessionId: "s1", cwd: "/tmp" },
			ttlMs: 1000,
		},
		1
	).id;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("leaseClockRecorder", () => {
	test("a mocked clock is recorded on the lease as the clock area, and real forgets it", () => {
		const record = leaseClockRecorder(store, leaseId, () => 42);
		record({ kind: "offset", ms: 86_400_000 });
		expect(activeConditions(store, leaseId)).toEqual([
			{ area: "clock", value: { kind: "offset", ms: 86_400_000 }, owned: [], setAt: 42 },
		]);
		record({ kind: "real" });
		expect(activeConditions(store, leaseId)).toEqual([]);
	});
});
