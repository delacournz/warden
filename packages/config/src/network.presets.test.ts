import { describe, expect, test } from "bun:test";
import type { NetworkPreset } from "./conditions.types";
import { NETWORK_PRESET_NAMES, NETWORK_PRESETS, resolveNetwork } from "./network.presets";

const EMU_NAMED_SPEEDS = ["gsm", "hscsd", "gprs", "edge", "umts", "hsdpa", "lte", "evdo", "full"];
const EMU_NAMED_DELAYS = ["gprs", "edge", "umts", "none"];

describe("NETWORK_PRESETS", () => {
	test("covers every preset name", () => {
		expect([...NETWORK_PRESET_NAMES].sort()).toEqual(["3g", "4g", "edge", "lossy", "lte", "slow", "wifi"]);
		for (const name of NETWORK_PRESET_NAMES) expect(NETWORK_PRESETS[name]).toBeDefined();
	});

	test("shaping numbers are finite and non-negative; loss is a percentage", () => {
		for (const name of NETWORK_PRESET_NAMES) {
			const { shaping } = NETWORK_PRESETS[name];
			for (const value of Object.values(shaping)) {
				expect(Number.isFinite(value)).toBe(true);
				expect(value).toBeGreaterThanOrEqual(0);
			}
			expect(shaping.lossPct).toBeLessThanOrEqual(100);
			expect(shaping.downKbps).toBeGreaterThan(0);
			expect(shaping.upKbps).toBeGreaterThan(0);
		}
	});

	test("emulator speed is a named profile or up:down kbps equal to the shaping numbers", () => {
		for (const name of NETWORK_PRESET_NAMES) {
			const { emu, shaping } = NETWORK_PRESETS[name];
			if (EMU_NAMED_SPEEDS.includes(emu.speed)) continue;
			expect(emu.speed).toBe(`${shaping.upKbps}:${shaping.downKbps}`);
		}
	});

	test("emulator delay is a named profile or an ordered min:max in ms", () => {
		for (const name of NETWORK_PRESET_NAMES) {
			const { emu } = NETWORK_PRESETS[name];
			if (EMU_NAMED_DELAYS.includes(emu.delay)) continue;
			const m = /^(\d+):(\d+)$/.exec(emu.delay);
			expect(m).not.toBeNull();
			expect(Number(m?.[1])).toBeLessThanOrEqual(Number(m?.[2]));
		}
	});

	test("downlink grows edge < 3g < 4g < lte; wifi has the lowest latency", () => {
		const down = (p: NetworkPreset): number => NETWORK_PRESETS[p].shaping.downKbps;
		expect(down("edge")).toBeLessThan(down("3g"));
		expect(down("3g")).toBeLessThan(down("4g"));
		expect(down("4g")).toBeLessThan(down("lte"));
		const latencies = NETWORK_PRESET_NAMES.map((n) => NETWORK_PRESETS[n].shaping.latencyMs);
		expect(NETWORK_PRESETS.wifi.shaping.latencyMs).toBe(Math.min(...latencies));
	});

	test("only lossy drops packets; slow has the highest latency", () => {
		for (const name of NETWORK_PRESET_NAMES) {
			expect(NETWORK_PRESETS[name].shaping.lossPct > 0).toBe(name === "lossy");
		}
		const latencies = NETWORK_PRESET_NAMES.map((n) => NETWORK_PRESETS[n].shaping.latencyMs);
		expect(NETWORK_PRESETS.slow.shaping.latencyMs).toBe(Math.max(...latencies));
	});
});

describe("resolveNetwork", () => {
	test("online is unshaped with the emulator's full/none", () => {
		expect(resolveNetwork({ kind: "online" })).toEqual({
			online: true,
			shaping: { latencyMs: 0, jitterMs: 0, downKbps: 0, upKbps: 0, lossPct: 0 },
			emu: { speed: "full", delay: "none" },
		});
	});

	test("offline has no shaping", () => {
		expect(resolveNetwork({ kind: "offline" })).toEqual({ online: false });
	});

	test("a preset resolves to its table row", () => {
		const plan = resolveNetwork({ kind: "preset", preset: "3g" });
		expect(plan).toEqual({ online: true, ...NETWORK_PRESETS["3g"] });
	});

	test("custom with nothing set is the unshaped network", () => {
		expect(resolveNetwork({ kind: "custom" })).toEqual(resolveNetwork({ kind: "online" }));
	});

	test("custom sets only what it names (0 = unlimited / none)", () => {
		const plan = resolveNetwork({ kind: "custom", latencyMs: 300, downKbps: 500 });
		if (!plan.online) throw new Error("expected online");
		expect(plan.shaping).toEqual({ latencyMs: 300, jitterMs: 0, downKbps: 500, upKbps: 0, lossPct: 0 });
	});

	test("custom emulator speed fills a missing direction with the other", () => {
		const plan = resolveNetwork({ kind: "custom", downKbps: 500 });
		if (!plan.online) throw new Error("expected online");
		expect(plan.emu.speed).toBe("500:500");
		const both = resolveNetwork({ kind: "custom", downKbps: 800, upKbps: 100 });
		if (!both.online) throw new Error("expected online");
		expect(both.emu.speed).toBe("100:800");
	});

	test("custom emulator delay is half the round trip, widened by jitter, never negative", () => {
		const plan = resolveNetwork({ kind: "custom", latencyMs: 200, jitterMs: 30 });
		if (!plan.online) throw new Error("expected online");
		expect(plan.emu.delay).toBe("70:130");
		const small = resolveNetwork({ kind: "custom", latencyMs: 10, jitterMs: 50 });
		if (!small.online) throw new Error("expected online");
		expect(small.emu.delay).toBe("0:55");
	});

	test("custom keeps loss in shaping", () => {
		const plan = resolveNetwork({ kind: "custom", lossPct: 12 });
		if (!plan.online) throw new Error("expected online");
		expect(plan.shaping.lossPct).toBe(12);
	});

	test("flap resolves to its up phase: the base, else online", () => {
		expect(resolveNetwork({ kind: "flap", upMs: 1, downMs: 1 })).toEqual(resolveNetwork({ kind: "online" }));
		expect(resolveNetwork({ kind: "flap", upMs: 1, downMs: 1, base: { kind: "preset", preset: "edge" } })).toEqual(
			resolveNetwork({ kind: "preset", preset: "edge" })
		);
	});

	test("clamps absurd custom numbers instead of passing them on", () => {
		const plan = resolveNetwork({ kind: "custom", lossPct: 250, latencyMs: -5, downKbps: -1 });
		if (!plan.online) throw new Error("expected online");
		expect(plan.shaping.lossPct).toBe(100);
		expect(plan.shaping.latencyMs).toBe(0);
		expect(plan.shaping.downKbps).toBe(0);
	});
});
