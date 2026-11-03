import { afterEach, describe, expect, test } from "bun:test";
import type { InventoryDevice, Owner } from "@delacour/warden-core/types";
import { err, ok } from "@delacour/warden-types/result";
import { type TestContext, testContext } from "../testing";
import { createDoctorCommand } from "./doctor";
import type { LeaseDoctorDeps } from "./doctor-leases";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const OWNER: Owner = { kind: "agent", sessionId: "a", cwd: "/" };

function deps(
	inventory: { ios?: InventoryDevice[]; android?: InventoryDevice[] },
	calls: string[] = []
): LeaseDoctorDeps {
	return {
		inventory: async (platform) => {
			calls.push(`inventory ${platform}`);
			const devices = inventory[platform];
			return devices ? ok(devices) : err(`${platform} tools missing`);
		},
		pidAlive: () => false,
		markerFs: { readText: () => undefined, writeText: () => {}, isDir: () => false },
	};
}

function run(argv: string[], d: LeaseDoctorDeps) {
	ctx = testContext(argv);
	const command = createDoctorCommand({
		helper: {} as never,
		fetch: async () => {
			throw new Error("no fetch");
		},
		leases: d,
	});
	return { c: ctx, command };
}

const json = (c: TestContext) => JSON.parse(c.stdout.join("\n"));

describe("warden doctor --leases", () => {
	test("clean registry: exit 0, no findings", async () => {
		const { c, command } = run(["--leases", "--json"], deps({ ios: [], android: [] }));
		expect(await command.run(c)).toBe(0);
		expect(json(c)).toMatchObject({ ok: true, findings: [], fixed: 0 });
	});

	test("drift without --fix: exit 1, reported, registry unchanged", async () => {
		const { c, command } = run(["--leases", "--json"], deps({ ios: [], android: [] }));
		const lease = c.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "GONE", name: "n" }, owner: OWNER, ttlMs: 60_000 },
			c.now()
		);
		expect(await command.run(c)).toBe(1);
		const out = json(c);
		expect(out.ok).toBe(false);
		expect(out.findings[0]).toMatchObject({
			kind: "lease_missing_device",
			severity: "drift",
			fixable: true,
			fixed: false,
		});
		expect(c.db.getLease(lease.id)).toBeDefined();
	});

	test("--fix deletes the dead lease, exits 0, and asks no provider to shut down or delete anything", async () => {
		const calls: string[] = [];
		const { c, command } = run(["--leases", "--fix", "--json"], deps({ ios: [], android: [] }, calls));
		const lease = c.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "GONE", name: "n" }, owner: OWNER, ttlMs: 60_000 },
			c.now()
		);
		let execs = 0;
		c.exec = async () => {
			execs++;
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		expect(await command.run(c)).toBe(0);
		expect(json(c)).toMatchObject({ ok: true, fixed: 1 });
		expect(c.db.getLease(lease.id)).toBeUndefined();
		expect(execs).toBe(0);
		expect(calls.sort()).toEqual(["inventory android", "inventory ios"]);
	});

	test("an unfixable drift (untracked booted sim) stays: exit 1 even with --fix", async () => {
		const naked: InventoryDevice = {
			platform: "ios",
			id: "N",
			name: "warden-iphone-17-1",
			state: "booted",
			wardenCreated: false,
		};
		const { c, command } = run(["--leases", "--fix", "--json"], deps({ ios: [naked], android: [] }));
		expect(await command.run(c)).toBe(1);
		expect(json(c).findings[0]).toMatchObject({ kind: "untracked_booted", fixable: false, fixed: false });
	});

	test("an unreadable inventory skips that platform and says so", async () => {
		const { c, command } = run(["--leases", "--json"], deps({ ios: [] }));
		c.db.insertLease(
			{
				resource: { kind: "device", platform: "android", id: "emulator-5554", name: "n" },
				owner: OWNER,
				ttlMs: 60_000,
			},
			c.now()
		);
		expect(await command.run(c)).toBe(0);
		expect(json(c).skipped[0]).toContain("android: inventory unavailable");
	});

	test("--fix without --leases is a usage error", async () => {
		const { c, command } = run(["--fix"], deps({}));
		expect(await command.run(c)).toBe(2);
		expect(c.stderr.join("\n")).toContain("--fix needs --leases");
	});
});
