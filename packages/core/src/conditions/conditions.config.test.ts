import { describe, expect, test } from "bun:test";
import {
	conditionsConfigSchema,
	mergeConditionsConfig,
	type NetworkInput,
	normalizeConditions,
	parseConditionsEnv,
	toNetworkCondition,
} from "./conditions.config";

const parse = (value: unknown) => conditionsConfigSchema.safeParse(value);

describe("conditionsConfigSchema", () => {
	test("accepts every area", () => {
		const ok = parse({
			network: "3g",
			location: { lat: 1, lon: 2 },
			clock: "2026-01-01T00:00:00Z",
			permissions: { location: "granted" },
			locale: "fr-FR",
			timezone: "Pacific/Auckland",
			a11y: { boldText: true },
		});
		expect(ok.success).toBe(true);
	});

	test("rejects unknown keys and bad values", () => {
		expect(parse({ battery: 1 }).success).toBe(false);
		expect(parse({ network: "5g" }).success).toBe(false);
		expect(parse({ location: { lat: 91, lon: 0 } }).success).toBe(false);
		expect(parse({ location: { lat: 0, lon: 181 } }).success).toBe(false);
		expect(parse({ clock: "not a date" }).success).toBe(false);
		expect(parse({ clock: { offset: "soon" } }).success).toBe(false);
		expect(parse({ permissions: { camera: "maybe" } }).success).toBe(false);
	});

	test("network takes a word or a custom shape", () => {
		expect(parse({ network: "offline" }).success).toBe(true);
		expect(parse({ network: { latencyMs: 300, downKbps: 500 } }).success).toBe(true);
		expect(parse({ network: { latencyMs: -1 } }).success).toBe(false);
		expect(parse({ network: { lossPct: 101 } }).success).toBe(false);
	});
});

describe("toNetworkCondition", () => {
	test("words and presets", () => {
		expect(toNetworkCondition("online")).toEqual({ success: true, data: { kind: "online" } });
		expect(toNetworkCondition("offline")).toEqual({ success: true, data: { kind: "offline" } });
		expect(toNetworkCondition("3g")).toEqual({ success: true, data: { kind: "preset", preset: "3g" } });
	});

	test("a condition passes through, a custom shape gets its kind", () => {
		expect(toNetworkCondition({ kind: "offline" })).toEqual({ success: true, data: { kind: "offline" } });
		expect(toNetworkCondition({ latencyMs: 5 })).toEqual({ success: true, data: { kind: "custom", latencyMs: 5 } });
	});

	test("an unknown word names the choices", () => {
		const res = toNetworkCondition("5g" as NetworkInput);
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("3g");
	});
});

describe("normalizeConditions", () => {
	test("network, location and clock become conditions", () => {
		const res = normalizeConditions({
			network: "lte",
			location: { lat: -36.8, lon: 174.7, altM: 10 },
			clock: "2026-03-01T00:00:00Z",
		});
		expect(res).toEqual({
			success: true,
			data: {
				conditions: {
					network: { kind: "preset", preset: "lte" },
					location: { kind: "point", lat: -36.8, lon: 174.7, altM: 10 },
					clock: { kind: "fixed", at: "2026-03-01T00:00:00.000Z" },
				},
				unapplied: [],
			},
		});
	});

	test("a location scenario name, a frozen clock and a clock offset", () => {
		const a = normalizeConditions({ location: "city-run", clock: { at: "2026-03-01T00:00:00Z", frozen: true } });
		expect(a.success && a.data.conditions).toEqual({
			location: { kind: "scenario", name: "city-run" },
			clock: { kind: "frozen", at: "2026-03-01T00:00:00.000Z" },
		});
		const b = normalizeConditions({ clock: { offset: "2d" } });
		expect(b.success && b.data.conditions.clock).toEqual({ kind: "offset", ms: 172_800_000 });
	});

	test("areas not applied yet are listed, not dropped silently", () => {
		const res = normalizeConditions({ network: "wifi", permissions: { camera: "denied" }, locale: "fr", a11y: {} });
		expect(res.success && res.data.unapplied).toEqual(["permissions", "locale", "a11y"]);
		expect(res.success && res.data.conditions).toEqual({ network: { kind: "preset", preset: "wifi" } });
	});

	test("nothing declared", () => {
		expect(normalizeConditions({})).toEqual({ success: true, data: { conditions: {}, unapplied: [] } });
	});
});

describe("mergeConditionsConfig", () => {
	test("the suite replaces the top-level value per area", () => {
		expect(mergeConditionsConfig({ network: "3g", locale: "fr" }, { network: "offline", timezone: "UTC" })).toEqual({
			network: "offline",
			locale: "fr",
			timezone: "UTC",
		});
	});

	test("undefined when neither sets anything", () => {
		expect(mergeConditionsConfig(undefined, undefined)).toBeUndefined();
		expect(mergeConditionsConfig({}, undefined)).toBeUndefined();
		expect(mergeConditionsConfig(undefined, { network: "wifi" })).toEqual({ network: "wifi" });
	});
});

describe("parseConditionsEnv", () => {
	test("JSON of the config round-trips", () => {
		const config = { network: "3g", location: { lat: 1, lon: 2 } } as const;
		expect(parseConditionsEnv(JSON.stringify(config))).toEqual({ success: true, data: config });
	});

	test("bad JSON and bad shape are errors", () => {
		expect(parseConditionsEnv("{").success).toBe(false);
		expect(parseConditionsEnv('{"network":"5g"}').success).toBe(false);
	});
});
