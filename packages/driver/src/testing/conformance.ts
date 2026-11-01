import { describe, expect, test } from "bun:test";
import type { Driver, DriverResult, Element, Point, Snapshot } from "../driver.types";

/**
 * Conformance suite for third-party drivers: `runDriverConformance("my farm", () => openMyDriver())` registers
 * bun:test cases that prove a {@link Driver} keeps the contract of `driver.types.ts` (results instead of throws,
 * snapshot shape, tap / typeText / swipe / screenshot / settle / app.launch results, idempotent close).
 * Every case opens its own driver and closes it.
 */
export type DriverConformanceOptions = {
	/** a bundle id / package the device can launch (default `com.example.conformance`; a failed launch must still be a typed error) */
	appId?: string;
	/** case names to leave out, for capabilities the driver declares it lacks */
	skip?: readonly string[];
};

const DEFAULT_APP = "com.example.conformance";

/** Conformance checks for third-party drivers. Use the shared {@link driverConformance} singleton. */
export class DriverConformance {
	/** Throws when `result` is not a well-formed `DriverResult` (`success` plus data, or a typed `DriverError`). */
	expectResultShape<T>(result: Awaited<DriverResult<T>>): void {
		expect(typeof result).toBe("object");
		expect(typeof result.success).toBe("boolean");
		if (result.success) return;
		expect(typeof result.error.code).toBe("string");
		expect(result.error.code.startsWith("E_")).toBe(true);
		expect(typeof result.error.message).toBe("string");
		expect(typeof result.error.retryable).toBe("boolean");
	}

	/** Assert the flat/tree invariants of a snapshot: `flat` is the preorder of `elements`, ids unique, depth consistent. */
	expectSnapshotInvariants(snapshot: Snapshot, platform: Driver["platform"]): void {
		expect(snapshot.platform).toBe(platform);
		expect(snapshot.screen.width).toBeGreaterThan(0);
		expect(snapshot.screen.height).toBeGreaterThan(0);
		expect(typeof snapshot.takenAt).toBe("number");
		expect(typeof snapshot.truncated).toBe("boolean");
		const preorder: Element[] = [];
		const walk = (nodes: readonly Element[], depth: number): void => {
			for (const node of nodes) {
				expect(node.depth).toBe(depth);
				preorder.push(node);
				walk(node.children, depth + 1);
			}
		};
		walk(snapshot.elements, 0);
		expect(snapshot.flat.length).toBe(preorder.length);
		for (const [index, node] of preorder.entries()) {
			expect(snapshot.flat[index]).toBe(node);
			expect(typeof node.id).toBe("string");
			expect(typeof node.role).toBe("string");
			expect(node.frame.width).toBeGreaterThanOrEqual(0);
			expect(node.frame.height).toBeGreaterThanOrEqual(0);
			expect(typeof node.enabled).toBe("boolean");
			expect(Array.isArray(node.traits)).toBe(true);
		}
		expect(new Set(preorder.map((n) => n.id)).size).toBe(preorder.length);
	}

	private async withDriver(make: () => Promise<Driver>, run: (driver: Driver) => Promise<void>): Promise<void> {
		const driver = await make();
		try {
			await run(driver);
		} finally {
			await driver.close();
		}
	}

	/** Register the conformance cases of `make` under `describe("driver conformance: <name>")`. */
	run(name: string, make: () => Promise<Driver>, options: DriverConformanceOptions = {}): void {
		const appId = options.appId ?? DEFAULT_APP;
		const skipped = new Set(options.skip ?? []);
		const centre = (s: Snapshot): Point => ({ x: s.screen.width / 2, y: s.screen.height / 2 });
		const check = (label: string, run: (driver: Driver) => Promise<void>): void => {
			if (skipped.has(label)) return;
			test(label, () => this.withDriver(make, run));
		};

		describe(`driver conformance: ${name}`, () => {
			check("identity: platform, id and capabilities are declared", async (d) => {
				expect(["ios", "android"]).toContain(d.platform);
				expect(d.id.length).toBeGreaterThan(0);
				expect([0, 1, 2]).toContain(d.capabilities.maxPointers);
				expect(typeof d.capabilities.pinch).toBe("boolean");
			});

			check("health returns a result naming the driver's device", async (d) => {
				const health = await d.health();
				this.expectResultShape(health);
				if (health.success) expect(health.data.platform).toBe(d.platform);
			});

			check("snapshot is flat + tree consistent", async (d) => {
				const snapshot = await d.snapshot();
				this.expectResultShape(snapshot);
				expect(snapshot.success).toBe(true);
				if (snapshot.success) this.expectSnapshotInvariants(snapshot.data, d.platform);
			});

			check("interactiveOnly snapshot keeps the same invariants", async (d) => {
				const snapshot = await d.snapshot({ interactiveOnly: true });
				this.expectResultShape(snapshot);
				if (snapshot.success) this.expectSnapshotInvariants(snapshot.data, d.platform);
			});

			check("elementAtPoint returns an element, null or a typed error", async (d) => {
				const shot = await d.snapshot();
				if (!shot.success) return;
				const hit = await d.elementAtPoint(centre(shot.data));
				this.expectResultShape(hit);
				if (hit.success && hit.data !== null) expect(typeof hit.data.id).toBe("string");
			});

			check("tap inside the screen resolves to a result", async (d) => {
				const shot = await d.snapshot();
				expect(shot.success).toBe(true);
				if (!shot.success) return;
				const tapped = await d.tap(centre(shot.data));
				this.expectResultShape(tapped);
				expect(tapped.success).toBe(true);
			});

			check("tap with a count and longPress resolve to results", async (d) => {
				const point = { x: 10, y: 10 };
				this.expectResultShape(await d.tap(point, { count: 2 }));
				this.expectResultShape(await d.longPress(point, { durationMs: 50 }));
			});

			check("swipe and drag resolve to results", async (d) => {
				const shot = await d.snapshot();
				if (!shot.success) return;
				const { width, height } = shot.data.screen;
				const swiped = await d.swipe({ x: width / 2, y: height * 0.7 }, { x: width / 2, y: height * 0.3 });
				this.expectResultShape(swiped);
				expect(swiped.success).toBe(true);
				this.expectResultShape(await d.drag({ x: width / 2, y: height * 0.6 }, { x: width / 2, y: height * 0.4 }));
			});

			check("typeText and key resolve to results", async (d) => {
				const typed = await d.typeText("warden");
				this.expectResultShape(typed);
				expect(typed.success).toBe(true);
				this.expectResultShape(await d.key("Enter"));
				this.expectResultShape(await d.key("Backspace", ["shift"]));
			});

			check("pressButton, orientation, appearance, clipboard and alert resolve to results", async (d) => {
				this.expectResultShape(await d.pressButton("home"));
				this.expectResultShape(await d.orientation());
				this.expectResultShape(await d.appearance());
				this.expectResultShape(await d.clipboard());
				this.expectResultShape(await d.alert());
			});

			check("pinch, rotate and gesture follow the declared capabilities", async (d) => {
				const centrePoint = { x: 100, y: 200 };
				this.expectResultShape(await d.pinch(centrePoint, 1.5));
				this.expectResultShape(await d.rotate(centrePoint, 45));
				const gesture = await d.gesture([{ points: [centrePoint, { x: 120, y: 220 }] }]);
				this.expectResultShape(gesture);
				if (d.capabilities.maxPointers === 0) expect(gesture.success).toBe(false);
			});

			check("screenshot returns a path or png bytes", async (d) => {
				const shot = await d.screenshot();
				this.expectResultShape(shot);
				expect(shot.success).toBe(true);
				if (shot.success) expect(shot.data.path !== undefined || shot.data.png !== undefined).toBe(true);
			});

			check("settle reports quiet and waitedMs", async (d) => {
				const settled = await d.settle({ quietMs: 50, timeoutMs: 2000 });
				this.expectResultShape(settled);
				expect(settled.success).toBe(true);
				if (settled.success) {
					expect(typeof settled.data.quiet).toBe("boolean");
					expect(settled.data.waitedMs).toBeGreaterThanOrEqual(0);
				}
			});

			check("app.launch / isRunning / terminate resolve to results", async (d) => {
				const launched = await d.app.launch(appId, { relaunch: true });
				this.expectResultShape(launched);
				expect(launched.success).toBe(true);
				const running = await d.app.isRunning(appId);
				this.expectResultShape(running);
				if (running.success) expect(typeof running.data).toBe("boolean");
				this.expectResultShape(await d.app.terminate(appId));
				this.expectResultShape(await d.app.isInstalled(appId));
				this.expectResultShape(await d.app.openUrl("https://example.com"));
			});

			check("methods never throw on out-of-range input", async (d) => {
				this.expectResultShape(await d.tap({ x: -1, y: -1 }));
				this.expectResultShape(await d.tap({ x: 1e9, y: 1e9 }));
				this.expectResultShape(await d.app.launch(""));
				this.expectResultShape(await d.elementAtPoint({ x: -5, y: -5 }));
			});

			check("close is idempotent", async () => {
				const driver = await make();
				await driver.close();
				await driver.close();
			});
		});
	}
}

export const driverConformance = new DriverConformance();
