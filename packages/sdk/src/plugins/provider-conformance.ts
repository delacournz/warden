import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWardenClient } from "../client";
import type { WardenClient, WardenClientOptions } from "../sdk.types";
import type { ProviderPlugin } from "./define-provider";

export type ProviderConformanceOptions = {
	/** extra env for both clients (defaults keep the host's capacity gate and window arranging off) */
	env?: Record<string, string>;
};

/**
 * The provider plugin conformance suite: a plugin must claim, show up in `devices.*`, and keep its lease usable
 * from a second client (another process in production) over the same `WARDEN_HOME`.
 * `makePlugin` is called once per client, as each process would build its own.
 */
export function runProviderConformance(
	label: string,
	makePlugin: () => ProviderPlugin,
	options: ProviderConformanceOptions = {}
): void {
	describe(`provider plugin conformance: ${label}`, () => {
		let dir = "";
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "warden-provider-conformance-"));
		});
		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});
		const client = (): WardenClient => {
			const env = {
				WARDEN_CAPACITY: "off",
				WARDEN_ARRANGE: "0",
				WARDEN_BACKGROUND: "0",
				WARDEN_SESSION_ID: "provider-conformance",
				HOME: "/nonexistent",
				...options.env,
				WARDEN_HOME: dir,
			};
			const opts: WardenClientOptions = { home: dir, host: { env, cwd: dir }, providers: [makePlugin()] };
			return createWardenClient(opts);
		};

		test("lists its devices and the claimed one carries its provider", async () => {
			const plugin = makePlugin();
			await using warden = client();
			const [lease] = await warden.leases.claim({ platform: plugin.platform, provider: plugin.name });
			expect(lease?.provider).toBe(plugin.name);
			const rows = await warden.devices.inventory({ platform: plugin.platform });
			const mine = rows.filter((r) => r.device.provider === plugin.name);
			expect(mine.length).toBeGreaterThan(0);
			expect(mine.filter((r) => r.lease?.id === lease?.id)).toHaveLength(1);
			const capacity = await warden.devices.capacity({ platform: plugin.platform });
			expect(capacity.some((c) => c.provider === plugin.name)).toBe(true);
		});

		test("a second client opens a session on a lease the first one claimed", async () => {
			const plugin = makePlugin();
			await using first = client();
			const [lease] = await first.leases.claim({ platform: plugin.platform, provider: plugin.name });
			if (!lease) throw new Error("claim returned no lease");
			await using second = client();
			const seen = (await second.devices.inventory({ platform: plugin.platform })).find(
				(r) => r.lease?.id === lease.id
			);
			expect(seen?.device.provider).toBe(plugin.name);
			await using session = await second.sessions.open({ lease });
			const snapshot = await session.capture.snapshot();
			expect(snapshot.platform).toBe(plugin.platform);
		});
	});
}
