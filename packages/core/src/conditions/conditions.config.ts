import { resolve } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import { parseDuration } from "../duration";
import {
	type A11yCondition,
	type ClockCondition,
	DEFAULT_PASSKEY_MODE,
	DEFAULT_PASSKEY_UV,
	KEYBOARD_MODES,
	type KeyboardCondition,
	type KeyboardMode,
	type LocationCondition,
	type NetworkCondition,
	type NetworkPreset,
	PASSKEY_MODES,
	PASSKEY_UV,
	type PasskeyMode,
	type PasskeyUv,
	PERMISSION_NAMES,
	type PermissionName,
	type PermissionState,
	TEXT_SIZE_NAMES,
} from "./conditions.types";
import { NETWORK_PRESET_NAMES } from "./network.presets";
import type { PasskeyInput } from "./passkey-store";
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

const passkeyModeSchema = z.enum(PASSKEY_MODES as readonly [PasskeyMode, ...PasskeyMode[]]);
const passkeyUvSchema = z.enum(PASSKEY_UV as readonly [PasskeyUv, ...PasskeyUv[]]);

/** A credential to seed, as `device.passkeys.add` takes it (checked again when it is created on the device). */
const passkeyInputSchema = z
	.object({
		rpId: z.string().min(1),
		userName: z.string(),
		displayName: z.string().optional(),
		userHandle: z.string().optional(),
		credentialId: z.string().optional(),
		privateKey: z.string().optional(),
		signCount: z.number().int().nonnegative().optional(),
	})
	.strict() satisfies z.ZodType<PasskeyInput>;

/** `passkeys`: a mode word, or `{ mode, uv, credentials }` (credentials seeded before the app launches). */
const passkeysConfigSchema = z.union([
	passkeyModeSchema,
	z
		.object({
			mode: passkeyModeSchema.optional(),
			uv: passkeyUvSchema.optional(),
			credentials: z.array(passkeyInputSchema).optional(),
		})
		.strict(),
]);

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
		/** `software` (on-screen keyboard shows, the default) or `hardware` (hidden, input as from a keyboard) */
		keyboard: z.enum(KEYBOARD_MODES as readonly [KeyboardMode, ...KeyboardMode[]]).optional(),
		/** the virtual authenticator: a mode (`auto`, `cancel`, `fail`, `unavailable`) or `{ mode, uv, credentials }` */
		passkeys: passkeysConfigSchema.optional(),
	})
	.strict();

export type ConditionsConfig = z.input<typeof conditionsConfigSchema>;

const cameraFeedInput = z.union([
	z.string().min(1),
	z.object({ path: z.string().min(1), loop: z.boolean().optional() }).strict(),
]);

/**
 * A suite's `camera` key: the asset each facing plays from the first `app.open()` on. A path, or `{ path, loop }`
 * (`loop` applies to a video, default true). Paths are relative to the config file.
 */
export const cameraConfigSchema = z
	.object({ back: cameraFeedInput.optional(), front: cameraFeedInput.optional() })
	.strict()
	.refine((v) => v.back !== undefined || v.front !== undefined, { message: "camera needs a back or a front asset" });

export type CameraConfig = z.input<typeof cameraConfigSchema>;

/** A suite's camera with absolute paths and a loop flag per facing: what `WARDEN_CAMERA_FEEDS` carries. */
export type CameraSuiteFeeds = Partial<Record<"back" | "front", { path: string; loop: boolean }>>;

/** `camera` as absolute paths (against `baseDir`, the config file's directory) with `loop` defaulted to true. */
export function resolveCameraConfig(config: CameraConfig, baseDir: string): CameraSuiteFeeds {
	const feeds: CameraSuiteFeeds = {};
	for (const facing of ["back", "front"] as const) {
		const input = config[facing];
		if (input === undefined) continue;
		const path = typeof input === "string" ? input : input.path;
		const loop = typeof input === "string" ? true : (input.loop ?? true);
		feeds[facing] = { path: resolve(baseDir, path), loop };
	}
	return feeds;
}

const cameraFeedsSchema = z
	.object({
		back: z
			.object({ path: z.string().min(1), loop: z.boolean() })
			.strict()
			.optional(),
		front: z
			.object({ path: z.string().min(1), loop: z.boolean() })
			.strict()
			.optional(),
	})
	.strict();

/** `WARDEN_CAMERA_FEEDS`: the JSON of a suite's resolved camera, checked again on the spec side. */
export function parseCameraFeedsEnv(raw: string): Result<CameraSuiteFeeds> {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return err("must be JSON");
	}
	const parsed = cameraFeedsSchema.safeParse(json);
	return parsed.success ? ok(parsed.data) : err(parsed.error.issues.map((i) => i.message).join("; "));
}

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
	keyboard?: KeyboardCondition;
	passkeys?: SuitePasskeys;
};

/** A suite's virtual authenticator: on from the first `app.open()`, with these credentials seeded. */
export type SuitePasskeys = { mode: PasskeyMode; uv: PasskeyUv; credentials?: PasskeyInput[] };

function toPasskeys(input: NonNullable<ConditionsConfig["passkeys"]>): SuitePasskeys {
	if (typeof input === "string") return { mode: input, uv: DEFAULT_PASSKEY_UV };
	return {
		mode: input.mode ?? DEFAULT_PASSKEY_MODE,
		uv: input.uv ?? DEFAULT_PASSKEY_UV,
		...(input.credentials === undefined ? {} : { credentials: input.credentials }),
	};
}

/** The areas that only change shape, never fail: everything but network and a11y. */
function shapedConditions(config: ConditionsConfig): SuiteConditions {
	return {
		...(config.location === undefined ? {} : { location: toLocation(config.location) }),
		...(config.clock === undefined ? {} : { clock: toClock(config.clock) }),
		...(config.permissions === undefined ? {} : { permissions: config.permissions }),
		...(config.locale === undefined ? {} : { locale: config.locale }),
		...(config.timezone === undefined ? {} : { timezone: config.timezone }),
		...(config.keyboard === undefined ? {} : { keyboard: { mode: config.keyboard } }),
		...(config.passkeys === undefined ? {} : { passkeys: toPasskeys(config.passkeys) }),
	};
}

/** A config as conditions: shaped values, with a text size resolved. */
export function normalizeConditions(config: ConditionsConfig): Result<{ conditions: SuiteConditions }> {
	const conditions: SuiteConditions = shapedConditions(config);
	if (config.network !== undefined) {
		const network = toNetworkCondition(config.network);
		if (!network.success) return network;
		conditions.network = network.data;
	}
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
