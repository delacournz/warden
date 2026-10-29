import { err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import { parseDuration } from "../duration";
import type { ClockCondition, LocationCondition, NetworkCondition, NetworkPreset } from "./conditions.types";
import { NETWORK_PRESET_NAMES } from "./network.presets";

const NETWORK_WORDS = ["online", "offline", ...NETWORK_PRESET_NAMES] as const;

const nonNegative = z.number().nonnegative().finite();

/** `network: { latencyMs, ... }`: the same fields as a `custom` network condition, without its `kind`. */
const customNetworkSchema = z
	.object({
		latencyMs: nonNegative.optional(),
		jitterMs: nonNegative.optional(),
		downKbps: nonNegative.optional(),
		upKbps: nonNegative.optional(),
		lossPct: z.number().min(0).max(100).optional(),
	})
	.strict();

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: "invalid date (use ISO 8601)" });
const offsetDuration = z
	.string()
	.refine((v) => parseDuration(v).success, { message: "invalid duration (use e.g. 2d)" });

/**
 * `conditions` (top level, or per `e2e.<suite>`): what every spec of the suite starts from. `network`, `location`
 * and `clock` are applied before the app launches and put back after each spec; the rest are accepted so a config
 * can be written once, and `warden e2e` says they are not applied yet.
 */
export const conditionsConfigSchema = z
	.object({
		/** a word (`online`, `offline`, a preset) or custom shaping */
		network: z.union([z.enum(NETWORK_WORDS), customNetworkSchema]).optional(),
		/** a point, or one of the bundled scenarios */
		location: z
			.union([
				z.enum(["city-run", "city-bike", "freeway"]),
				z
					.object({
						lat: z.number().min(-90).max(90),
						lon: z.number().min(-180).max(180),
						altM: z.number().finite().optional(),
					})
					.strict(),
			])
			.optional(),
		/** an ISO instant the clock starts at, or `{ at, frozen }`, or `{ offset }` from now */
		clock: z
			.union([
				isoDate,
				z.object({ at: isoDate, frozen: z.boolean().optional() }).strict(),
				z.object({ offset: offsetDuration }).strict(),
			])
			.optional(),
		/** not applied yet */
		permissions: z.record(z.string().min(1), z.enum(["granted", "denied", "unset"])).optional(),
		/** not applied yet */
		locale: z.string().min(1).optional(),
		/** not applied yet */
		timezone: z.string().min(1).optional(),
		/** not applied yet */
		a11y: z.record(z.string().min(1), z.unknown()).optional(),
	})
	.strict();

export type ConditionsConfig = z.input<typeof conditionsConfigSchema>;

/** The areas a config can name that nothing applies yet. */
const UNAPPLIED = ["permissions", "locale", "timezone", "a11y"] as const;

/** What a spec's `device.network.set` takes: a condition, or its word. */
export type NetworkInput = NetworkCondition | "online" | "offline" | NetworkPreset;

const isWord = (v: string): v is "online" | "offline" | NetworkPreset =>
	(NETWORK_WORDS as readonly string[]).includes(v);

/** A word, a custom shape (config) or a ready condition, as a `NetworkCondition`. */
export function toNetworkCondition(
	input: NetworkInput | z.infer<typeof customNetworkSchema>
): Result<NetworkCondition> {
	if (typeof input === "string") {
		if (!isWord(input)) return err(`unknown network "${input}" (use ${NETWORK_WORDS.join(", ")})`);
		if (input === "online" || input === "offline") return ok({ kind: input });
		return ok({ kind: "preset", preset: input });
	}
	if ("kind" in input) return ok(input);
	return ok({ kind: "custom", ...input });
}

function toLocation(input: NonNullable<ConditionsConfig["location"]>): LocationCondition {
	if (typeof input === "string") return { kind: "scenario", name: input };
	return { kind: "point", lat: input.lat, lon: input.lon, ...(input.altM === undefined ? {} : { altM: input.altM }) };
}

function toClock(input: NonNullable<ConditionsConfig["clock"]>): ClockCondition {
	if (typeof input === "string") return { kind: "fixed", at: new Date(input).toISOString() };
	if ("offset" in input) {
		const ms = parseDuration(input.offset);
		return { kind: "offset", ms: ms.success ? ms.data : 0 };
	}
	const at = new Date(input.at).toISOString();
	return input.frozen === true ? { kind: "frozen", at } : { kind: "fixed", at };
}

export type SuiteConditions = { network?: NetworkCondition; location?: LocationCondition; clock?: ClockCondition };

/** The applicable part of a config as conditions, and the names of the areas that nothing applies yet. */
export function normalizeConditions(
	config: ConditionsConfig
): Result<{ conditions: SuiteConditions; unapplied: string[] }> {
	const conditions: SuiteConditions = {};
	if (config.network !== undefined) {
		const network = toNetworkCondition(config.network);
		if (!network.success) return network;
		conditions.network = network.data;
	}
	if (config.location !== undefined) conditions.location = toLocation(config.location);
	if (config.clock !== undefined) conditions.clock = toClock(config.clock);
	return ok({ conditions, unapplied: UNAPPLIED.filter((key) => config[key] !== undefined) });
}

/** The suite's `conditions` over the top-level ones, per area; undefined when neither sets any. */
export function mergeConditionsConfig(
	top: ConditionsConfig | undefined,
	own: ConditionsConfig | undefined
): ConditionsConfig | undefined {
	const merged: ConditionsConfig = { ...top, ...own };
	return Object.keys(merged).length > 0 ? merged : undefined;
}

/** `WARDEN_CONDITIONS`: the JSON of a suite's config, checked again on the spec side. */
export function parseConditionsEnv(raw: string): Result<ConditionsConfig> {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return err("must be JSON");
	}
	const parsed = conditionsConfigSchema.safeParse(json);
	return parsed.success ? ok(parsed.data) : err(parsed.error.issues.map((i) => i.message).join("; "));
}
