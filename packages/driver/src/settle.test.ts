import { describe, expect, test } from "bun:test";
import { driverFixtures } from "./driver.testing";
import { type SettleDetail, settler } from "./settle";

/** Fake clock: `sleep` advances time, `now` reads it. */
function clock() {
	let t = 1000;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
		tick: (ms: number) => {
			t += ms;
		},
	};
}

describe("settler.byHash", () => {
	test("quiet once the hash is stable for quietMs", async () => {
		const c = clock();
		const result = await settler.byHash(async () => "a", { quietMs: 200, timeoutMs: 2000, pollMs: 50, ...c });
		expect(result).toEqual({ quiet: true, waitedMs: 200 });
	});

	test("a change restarts the quiet window", async () => {
		const c = clock();
		const hashes = ["a", "b", "b", "b", "b", "b", "b", "b"];
		let i = 0;
		const result = await settler.byHash(async () => hashes[Math.min(i++, hashes.length - 1)] ?? "", {
			quietMs: 150,
			timeoutMs: 2000,
			pollMs: 50,
			...c,
		});
		// polls: a@0, b@50 (change), b@100, b@150, b@200 → 150 ms since the change
		expect(result).toEqual({ quiet: true, waitedMs: 200 });
	});

	test("times out with quiet:false while the hash keeps changing", async () => {
		const c = clock();
		let n = 0;
		const result = await settler.byHash(async () => `h${n++}`, { quietMs: 100, timeoutMs: 500, pollMs: 50, ...c });
		expect(result).toEqual({ quiet: false, waitedMs: 500 });
	});

	test("never sleeps past the timeout", async () => {
		const c = clock();
		const slept: number[] = [];
		let n = 0;
		await settler.byHash(async () => `h${n++}`, {
			quietMs: 100,
			timeoutMs: 120,
			pollMs: 50,
			now: c.now,
			sleep: async (ms) => {
				slept.push(ms);
				await c.sleep(ms);
			},
		});
		expect(slept).toEqual([50, 50, 20]);
	});

	test("slow polls count toward waitedMs", async () => {
		const c = clock();
		const result = await settler.byHash(
			async () => {
				c.tick(300);
				return "same";
			},
			{ quietMs: 100, timeoutMs: 5000, pollMs: 50, ...c }
		);
		expect(result.quiet).toBe(true);
		expect(result.waitedMs).toBeGreaterThanOrEqual(350);
	});

	test("quietMs 0 settles after the second equal hash", async () => {
		const c = clock();
		const result = await settler.byHash(async () => "a", { quietMs: 0, timeoutMs: 1000, pollMs: 10, ...c });
		expect(result).toEqual({ quiet: true, waitedMs: 10 });
	});
});

describe("settler.snapshotHash", () => {
	const base = () =>
		driverFixtures.snapshotOf([
			driverFixtures.el("button", { id: "go", label: "Go", frame: { x: 0, y: 0, width: 100, height: 40 } }),
		]);

	test("identical trees hash equal", () => {
		expect(settler.snapshotHash(base())).toBe(settler.snapshotHash(base()));
	});

	test("label, value, identifier, role and frame all matter", () => {
		const hash = settler.snapshotHash(base());
		const frame = { x: 0, y: 0, width: 100, height: 40 };
		expect(
			settler.snapshotHash(driverFixtures.snapshotOf([driverFixtures.el("button", { id: "go", label: "Stop", frame })]))
		).not.toBe(hash);
		expect(
			settler.snapshotHash(
				driverFixtures.snapshotOf([driverFixtures.el("button", { id: "go", label: "Go", value: "1", frame })])
			)
		).not.toBe(hash);
		expect(
			settler.snapshotHash(driverFixtures.snapshotOf([driverFixtures.el("button", { id: "go2", label: "Go", frame })]))
		).not.toBe(hash);
		expect(
			settler.snapshotHash(driverFixtures.snapshotOf([driverFixtures.el("link", { id: "go", label: "Go", frame })]))
		).not.toBe(hash);
		expect(
			settler.snapshotHash(
				driverFixtures.snapshotOf([driverFixtures.el("button", { id: "go", label: "Go", frame: { ...frame, x: 8 } })])
			)
		).not.toBe(hash);
	});

	test("sub-point jitter and unrelated fields are ignored", () => {
		const hash = settler.snapshotHash(base());
		const frame = { x: 0.2, y: 0, width: 100.1, height: 40 };
		expect(
			settler.snapshotHash(
				driverFixtures.snapshotOf([
					driverFixtures.el("button", { id: "go", label: "Go", frame, enabled: false, hittable: true }),
				])
			)
		).toBe(hash);
	});
});

describe("settler.detailOf", () => {
	test("keeps the extra fields a driver reports next to quiet and waitedMs", () => {
		const reply: SettleDetail = {
			quiet: false,
			waitedMs: 8000,
			via: "stream",
			reason: "frontmost_mismatch",
			frontmostPid: 4242,
		};
		expect(settler.detailOf(reply)).toEqual(reply);
	});

	test("a plain outcome stays plain", () => {
		expect(settler.detailOf({ quiet: true, waitedMs: 250 })).toEqual({ quiet: true, waitedMs: 250 });
	});

	test("fields of the wrong type or an unknown via are dropped, never passed on", () => {
		const reply = { quiet: true, waitedMs: 1, via: "telepathy", reason: 7, frontmostPid: "12" };
		expect(settler.detailOf(reply)).toEqual({ quiet: true, waitedMs: 1 });
	});

	test("via takes stream, snapshot and hash", () => {
		for (const via of ["stream", "snapshot", "hash"]) {
			const reply = { quiet: true, waitedMs: 1, via };
			expect(settler.detailOf(reply)).toMatchObject({ via });
		}
	});
});
