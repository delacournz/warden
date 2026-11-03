import { afterEach, describe, expect, test } from "bun:test";
import { err, ok } from "@delacour/warden-types/result";
import {
	GOLDEN_PRUNE_INTERVAL_MS,
	GOLDEN_PRUNED_META_KEY,
	type GoldenPrunes,
	goldenPruneDue,
	goldenPrunePass,
} from "./golden-prune";
import { type TestContext, testContext } from "./testing";

const NOW = 60_000;
const OWNER = { kind: "agent", sessionId: "s", cwd: "/" } as const;

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

type Seen = { ios: Array<{ all: boolean; cautious?: boolean; lockWaitMs?: number }>; android: number };

function prunes(seen: Seen, over: Partial<GoldenPrunes> = {}): GoldenPrunes {
	return {
		ios: async (deps, opts) => {
			seen.ios.push({ ...opts, lockWaitMs: deps.timing?.lockWaitMs });
			return ok([
				{
					udid: "G0",
					name: "warden-golden-iphone-17-old",
					state: "Shutdown",
					isAvailable: true,
					runtimeId: "iOS-26-5",
				},
			]);
		},
		android: async (deps, opts) => {
			seen.android++;
			expect(opts).toEqual({ all: false, cautious: true });
			expect(deps.timing?.lockWaitMs).toBe(0);
			return ok([{ avd: "Pixel_10", name: "warden-0000000000", path: "/x", current: false }]);
		},
		...over,
	};
}

function context(env: Record<string, string> = {}): TestContext {
	ctx = testContext([], { now: () => NOW });
	ctx.env = { ...ctx.env, ...env };
	return ctx;
}

describe("goldenPrunePass", () => {
	test("prunes stale goldens on both platforms, cautiously and without waiting on the golden lock; stamps the throttle", async () => {
		const c = context();
		const seen: Seen = { ios: [], android: 0 };
		const pass = await goldenPrunePass(c, OWNER, prunes(seen));
		expect(seen.ios).toEqual([{ all: false, cautious: true, lockWaitMs: 0 }]);
		expect(seen.android).toBe(1);
		expect(pass.goldens).toEqual([
			{ platform: "ios", name: "warden-golden-iphone-17-old" },
			{ platform: "android", name: "Pixel_10/warden-0000000000" },
		]);
		expect(c.db.getMeta(GOLDEN_PRUNED_META_KEY)).toBe(String(NOW));
	});

	test("throttled: within 24 h of the last prune nothing runs", async () => {
		const c = context();
		c.db.setMeta(GOLDEN_PRUNED_META_KEY, String(NOW - GOLDEN_PRUNE_INTERVAL_MS + 1));
		const seen: Seen = { ios: [], android: 0 };
		expect((await goldenPrunePass(c, OWNER, prunes(seen))).goldens).toEqual([]);
		expect(seen).toEqual({ ios: [], android: 0 });
	});

	test("WARDEN_GOLDEN_PRUNE=0 or WARDEN_GOLDEN=0: nothing runs", async () => {
		const envs: Array<Record<string, string>> = [{ WARDEN_GOLDEN_PRUNE: "0" }, { WARDEN_GOLDEN: "0" }];
		for (const env of envs) {
			const c = context(env);
			const seen: Seen = { ios: [], android: 0 };
			await goldenPrunePass(c, OWNER, prunes(seen));
			expect(seen).toEqual({ ios: [], android: 0 });
			c.cleanup();
		}
		ctx = undefined;
	});

	test("a failing platform (no Xcode, no SDK, lock busy) is silent; the other still prunes; the throttle is stamped", async () => {
		const c = context();
		const seen: Seen = { ios: [], android: 0 };
		const pass = await goldenPrunePass(c, OWNER, prunes(seen, { ios: async () => err("xcrun: not found") }));
		expect(pass).toEqual({ goldens: [{ platform: "android", name: "Pixel_10/warden-0000000000" }] });
		expect(c.db.getMeta(GOLDEN_PRUNED_META_KEY)).toBe(String(NOW));
	});
});

describe("goldenPruneDue", () => {
	test("due when never pruned or 24 h since; not when off", () => {
		const c = context();
		expect(goldenPruneDue(c.db, c.env, NOW)).toBe(true);
		c.db.setMeta(GOLDEN_PRUNED_META_KEY, String(NOW - 1));
		expect(goldenPruneDue(c.db, c.env, NOW)).toBe(false);
		expect(goldenPruneDue(c.db, c.env, NOW - 1 + GOLDEN_PRUNE_INTERVAL_MS)).toBe(true);
		expect(goldenPruneDue(c.db, { WARDEN_GOLDEN_PRUNE: "0" }, NOW + GOLDEN_PRUNE_INTERVAL_MS)).toBe(false);
		expect(goldenPruneDue(c.db, { WARDEN_GOLDEN: "0" }, NOW + GOLDEN_PRUNE_INTERVAL_MS)).toBe(false);
	});
});
