import { err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import { parseDuration } from "../duration";
import {
	type A11yCondition,
	type ClockCondition,
	type LocationCondition,
	type NetworkCondition,
	type NetworkPreset,
	PERMISSION_NAMES,
	type PermissionName,
	type PermissionState,
	TEXT_SIZE_NAMES,
} from "./conditions.types";
import { NETWORK_PRESET_NAMES } from "./network.presets";
import { resolveTextSize } from "./text-size";

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

const textSize = z.union([z.enum(TEXT_SIZE_NAMES), z.number().positive().finite()]);

/** `a11y`: text size (a category name or a font scale), bold text, contrast and reduce motion. */
const a11yConfigSchema = z
	.object({
		textSize: textSize.optional(),
		boldText: z.boolean().optional(),
		contrast: z.enum(["increased", "normal"]).optional(),
		reduceMotion: z.boolean().optional(),
	})
	.strict();

/**
 * `conditions` (top level, or per `e2e.<suite>`): what every spec of the suite starts from. `network`, `location`
 * and `clock` are applied before the app launches and put back after each spec, as are `permissions`, `locale`,
 * `timezone` and `a11y`.
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
		/** permission name to state, granted to the suite's app before it launches */
		permissions: z.partialRecord(z.enum(PERMISSION_NAMES), z.enum(["granted", "denied", "unset"])).optional(),
		/** a BCP 47 tag (`fr-FR`) for the suite's app */
		locale: z.string().min(1).optional(),
		/** an IANA timezone (`Asia/Tokyo`) */
		timezone: z.string().min(1).optional(),
		a11y: a11yConfigSchema.optional(),
	})
	.strict();

export type ConditionsConfig = z.input<typeof conditionsConfigSchema>;

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

export type SuiteConditions = {
	network?: NetworkCondition;
	location?: LocationCondition;
	clock?: ClockCondition;
	permissions?: Partial<Record<PermissionName, PermissionState>>;
	locale?: string;
	timezone?: string;
	a11y?: A11yCondition;
};

/** A config as conditions: shaped values, with a text size resolved. */
export function normalizeConditions(config: ConditionsConfig): Result<{ conditions: SuiteConditions }> {
	const conditions: SuiteConditions = {};
	if (config.network !== undefined) {
		const network = toNetworkCondition(config.network);
		if (!network.success) return network;
		conditions.network = network.data;
	}
	if (config.location !== undefined) conditions.location = toLocation(config.location);
	if (config.clock !== undefined) conditions.clock = toClock(config.clock);
	if (config.permissions !== undefined) conditions.permissions = config.permissions;
	if (config.locale !== undefined) conditions.locale = config.locale;
	if (config.timezone !== undefined) conditions.timezone = config.timezone;
	if (config.a11y !== undefined) {
		const a11y: A11yCondition = { ...config.a11y };
		if (config.a11y.textSize !== undefined) {
			const size = resolveTextSize(config.a11y.textSize);
			if (!size.success) return size;
			a11y.fontScale = size.data.scale;
		}
		conditions.a11y = a11y;
	}
	return ok({ conditions });
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
