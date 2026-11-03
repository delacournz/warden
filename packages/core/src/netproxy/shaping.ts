import type { HostFault, NetworkCondition } from "../conditions/conditions.types";
import { type NetworkShaping, resolveNetwork } from "../conditions/network.presets";

/** How an `offline` proxy treats connections: close at accept, or accept and never answer. */
export type OfflineMode = "refuse" | "blackhole";

/**
 * What the proxy does to traffic: the shared `NetworkShaping` fields (all optional here; unset / 0 = no
 * limit, delay or loss) plus `offline`. `latencyMs` is the added round trip: the full amount at connection
 * open, half on each direction's chunks. `jitterMs` spreads each delay by +/- that much (halved per chunk).
 * `lossPct` (0-100) resets or stalls (half each) a connection at open.
 */
export type ShapingParams = Partial<NetworkShaping> & { offline?: OfflineMode };

/** Proxy params for a condition (presets table); `offline` refuses connections. Faults are separate. */
export function shapingFromCondition(condition: NetworkCondition): ShapingParams {
	const plan = resolveNetwork(condition);
	return plan.online ? { ...plan.shaping } : { offline: "refuse" };
}

/** The live state of a proxy: what `setProxyConditions` replaces. */
export type ProxyConditions = { params: ShapingParams; faults: readonly HostFault[] };

export const NO_CONDITIONS: ProxyConditions = { params: {}, faults: [] };

/** Uniform [0, 1); injectable so loss and jitter are reproducible in tests. */
export type Rng = () => number;

/** mulberry32: tiny seeded PRNG. */
export function seededRng(seed: number): Rng {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/** `(latencyMs ± jitterMs) * scale`, floored at 0. */
export function delayMs(params: ShapingParams, rng: Rng, scale = 1): number {
	const base = (params.latencyMs ?? 0) * scale;
	const jitter = (params.jitterMs ?? 0) * scale;
	if (jitter <= 0) return Math.max(0, base);
	return Math.max(0, base + (rng() * 2 - 1) * jitter);
}

/** `*` matches any run of characters; case-insensitive; the whole host must match. */
export function hostMatches(glob: string, host: string): boolean {
	const pattern = glob
		.toLowerCase()
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${pattern}$`).test(host.toLowerCase());
}

/** First fault whose glob matches `host`. */
export function faultFor(faults: readonly HostFault[], host: string): HostFault | undefined {
	return faults.find((f) => hostMatches(f.match, host));
}

/**
 * Serialises sends at a fixed rate: `waitMs` says how long until the next `bytes` may go out, and
 * `take` books them. The rate is read per call, so a live change applies to the next slice.
 */
export class TokenBucket {
	private nextFree = 0;

	/** ms until `bytes` may be sent at `kbps` (0 = now); unlimited when `kbps` is unset or ≤ 0 */
	waitMs(now: number): number {
		return Math.max(0, this.nextFree - now);
	}

	take(bytes: number, kbps: number | undefined, now: number): void {
		if (kbps === undefined || kbps <= 0) {
			this.nextFree = 0;
			return;
		}
		const start = Math.max(now, this.nextFree);
		this.nextFree = start + (bytes * 8) / kbps;
	}
}

/** Slice size giving ~50 ms granularity at `kbps`, within 256 B – 64 KB. */
export function sliceSize(kbps: number | undefined): number {
	if (kbps === undefined || kbps <= 0) return 65_536;
	return Math.min(65_536, Math.max(256, Math.floor((kbps * 1000) / 8 / 20)));
}
