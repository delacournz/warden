import type { NetworkCondition, NetworkPreset } from "./conditions.types";

/**
 * One table for every layer that applies a network condition: the Android emulator console (`emu network
 * speed|delay`, COND-3), the per-lease shaping proxy (COND-4) and the iOS per-app routing (COND-5).
 *
 * Shaping units: `latencyMs` is the added round-trip time, `jitterMs` the +/- spread on it, kbps are
 * kilobits per second (0 = unlimited), `lossPct` is 0-100. The emulator console's `delay` is per packet, so
 * its `min:max` is half the round trip, widened by the jitter.
 *
 * Sources: Apple Network Link Conditioner profiles (edge, 3g, lte, wifi, lossy = "Very Bad Network"),
 * Chrome DevTools "Slow 3G" (400 kbps both ways, 2000 ms), WebPageTest "4G" (9 Mbps, 170 ms RTT).
 */

export type NetworkShaping = {
	latencyMs: number;
	jitterMs: number;
	downKbps: number;
	upKbps: number;
	lossPct: number;
};

/** Arguments for `adb emu network speed <speed>` and `... delay <delay>`. */
export type EmuNetwork = { speed: string; delay: string };

export type NetworkPresetSpec = { emu: EmuNetwork; shaping: NetworkShaping };

export const NETWORK_PRESET_NAMES: readonly NetworkPreset[] = ["edge", "3g", "4g", "lte", "wifi", "slow", "lossy"];

export const NETWORK_PRESETS: Readonly<Record<NetworkPreset, NetworkPresetSpec>> = {
	edge: {
		emu: { speed: "200:240", delay: "175:225" },
		shaping: { latencyMs: 400, jitterMs: 25, downKbps: 240, upKbps: 200, lossPct: 0 },
	},
	"3g": {
		emu: { speed: "330:780", delay: "40:60" },
		shaping: { latencyMs: 100, jitterMs: 10, downKbps: 780, upKbps: 330, lossPct: 0 },
	},
	"4g": {
		emu: { speed: "9000:9000", delay: "70:100" },
		shaping: { latencyMs: 170, jitterMs: 15, downKbps: 9000, upKbps: 9000, lossPct: 0 },
	},
	lte: {
		emu: { speed: "10000:50000", delay: "20:30" },
		shaping: { latencyMs: 50, jitterMs: 5, downKbps: 50_000, upKbps: 10_000, lossPct: 0 },
	},
	wifi: {
		emu: { speed: "33000:40000", delay: "0:1" },
		shaping: { latencyMs: 2, jitterMs: 0, downKbps: 40_000, upKbps: 33_000, lossPct: 0 },
	},
	slow: {
		emu: { speed: "400:400", delay: "900:1100" },
		shaping: { latencyMs: 2000, jitterMs: 100, downKbps: 400, upKbps: 400, lossPct: 0 },
	},
	lossy: {
		emu: { speed: "1000:1000", delay: "200:300" },
		shaping: { latencyMs: 500, jitterMs: 50, downKbps: 1000, upKbps: 1000, lossPct: 10 },
	},
};

/** What a condition means for a device: no network at all, or shaped (all zeros = unshaped) with the emulator args. */
export type NetworkPlan = { online: false } | ({ online: true } & NetworkPresetSpec);

const UNSHAPED: NetworkShaping = { latencyMs: 0, jitterMs: 0, downKbps: 0, upKbps: 0, lossPct: 0 };
const UNSHAPED_EMU: EmuNetwork = { speed: "full", delay: "none" };

const nonNegative = (value: number | undefined): number =>
	value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, value);

function customEmu(shaping: NetworkShaping): EmuNetwork {
	const { downKbps, upKbps, latencyMs, jitterMs } = shaping;
	const speed = downKbps === 0 && upKbps === 0 ? UNSHAPED_EMU.speed : `${upKbps || downKbps}:${downKbps || upKbps}`;
	const half = latencyMs / 2;
	const min = Math.max(0, Math.round(half - jitterMs));
	const max = Math.round(half + jitterMs);
	const delay = max === 0 ? UNSHAPED_EMU.delay : `${min}:${max}`;
	return { speed, delay };
}

/**
 * The effective parameters of a condition. `custom` names only what it changes (the rest is unshaped, a
 * direction left out takes the other's rate for the emulator); `flap` resolves to its up phase, because the
 * scheduler (COND-6) drives the transitions as plain online/offline conditions.
 */
export function resolveNetwork(condition: NetworkCondition): NetworkPlan {
	switch (condition.kind) {
		case "offline":
			return { online: false };
		case "online":
			return { online: true, shaping: UNSHAPED, emu: UNSHAPED_EMU };
		case "preset":
			return { online: true, ...NETWORK_PRESETS[condition.preset] };
		case "flap":
			return resolveNetwork(condition.base ?? { kind: "online" });
		case "custom": {
			const shaping: NetworkShaping = {
				latencyMs: nonNegative(condition.latencyMs),
				jitterMs: nonNegative(condition.jitterMs),
				downKbps: nonNegative(condition.downKbps),
				upKbps: nonNegative(condition.upKbps),
				lossPct: Math.min(100, nonNegative(condition.lossPct)),
			};
			return { online: true, shaping, emu: customEmu(shaping) };
		}
	}
}
