import type {
	HostFault,
	LatLon,
	LocationScenario,
	NetworkCondition,
	NetworkPreset,
} from "@delacour/warden-core/conditions/conditions.types";
import { NETWORK_PRESET_NAMES, NETWORK_PRESETS } from "@delacour/warden-core/conditions/network.presets";
import { parseDuration } from "@delacour/warden-core/duration";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "./output";

/** Words `warden ui net` takes besides the condition words. */
export const NET_ACTIONS = ["flap", "fault", "status", "reset"] as const;
export const NETWORK_WORDS: readonly string[] = ["online", "offline", ...NETWORK_PRESET_NAMES];
export const LOCATION_SCENARIOS: readonly LocationScenario[] = ["city-run", "city-bike", "freeway"];

const usage = (message: string, hint?: string) =>
	({ success: false, error: uiError("usage", message, hint === undefined ? {} : { hint }) }) as const;

/** The shaping flags of `net <condition>`; every value arrives as text. */
export type ShapingFlags = { latency?: string; jitter?: string; down?: string; up?: string; loss?: string };

function number(raw: string | undefined, flag: string, max?: number): Result<number | undefined, UiError> {
	if (raw === undefined) return ok(undefined);
	const value = Number(raw);
	if (raw.trim() === "" || !Number.isFinite(value) || value < 0 || (max !== undefined && value > max)) {
		return usage(`${flag} must be a number from 0${max === undefined ? "" : ` to ${max}`}, got "${raw}"`);
	}
	return ok(value);
}

/**
 * `online` | `offline` | a preset, optionally with shaping flags: flags on a preset override its values (the result is
 * a `custom` condition), flags on `online` shape an otherwise open network, flags on `offline` are an error.
 */
export function parseNetworkCondition(word: string, flags: ShapingFlags): Result<NetworkCondition, UiError> {
	if (!NETWORK_WORDS.includes(word)) {
		return usage(`unknown network "${word}"`, `${[...NETWORK_WORDS, ...NET_ACTIONS].join(", ")}`);
	}
	const parsed = {
		latencyMs: number(flags.latency, "--latency"),
		jitterMs: number(flags.jitter, "--jitter"),
		downKbps: number(flags.down, "--down"),
		upKbps: number(flags.up, "--up"),
		lossPct: number(flags.loss, "--loss", 100),
	};
	for (const field of Object.values(parsed)) if (!field.success) return field;
	const given = Object.entries(parsed).flatMap(([key, field]) =>
		field.success && field.data !== undefined ? ([[key, field.data]] as const) : []
	);
	if (word === "offline") {
		return given.length > 0 ? usage("offline takes no shaping flags") : ok({ kind: "offline" });
	}
	if (given.length === 0) {
		return ok(word === "online" ? { kind: "online" } : { kind: "preset", preset: word as NetworkPreset });
	}
	const base = word === "online" ? {} : NETWORK_PRESETS[word as NetworkPreset].shaping;
	return ok({ kind: "custom", ...base, ...Object.fromEntries(given) });
}

export type FlapFlags = { up?: string; down?: string; jitter?: string; seed?: string };

export type FlapSpec = { upMs: number; downMs: number; jitterPct?: number; seed?: number };

/** `flap --up 10s --down 3s [--jitter pct] [--seed n]`. */
export function parseFlap(flags: FlapFlags): Result<FlapSpec, UiError> {
	if (flags.up === undefined || flags.down === undefined) {
		return usage("flap needs --up and --down", "warden ui net flap --up 10s --down 3s");
	}
	const upMs = parseDuration(flags.up);
	if (!upMs.success) return usage(`--up: ${upMs.error}`);
	const downMs = parseDuration(flags.down);
	if (!downMs.success) return usage(`--down: ${downMs.error}`);
	if (!(upMs.data > 0 && downMs.data > 0)) return usage("flap needs --up and --down above 0");
	const jitterPct = number(flags.jitter, "--jitter", 100);
	if (!jitterPct.success) return jitterPct;
	let seed: number | undefined;
	if (flags.seed !== undefined) {
		seed = Number(flags.seed);
		if (!Number.isInteger(seed)) return usage(`--seed must be an integer, got "${flags.seed}"`);
	}
	return ok({
		upMs: upMs.data,
		downMs: downMs.data,
		...(jitterPct.data === undefined ? {} : { jitterPct: jitterPct.data }),
		...(seed === undefined ? {} : { seed }),
	});
}

/** `status:503` | `reset` | `delay:2s` | `blackhole` for requests to hosts matching `match`. */
export function parseFault(match: string, rule: string): Result<HostFault, UiError> {
	if (match.trim() === "") return usage("fault needs a host glob");
	const [kind, arg] = rule.split(/:(.*)/s, 2) as [string, string | undefined];
	if (kind === "reset" || kind === "blackhole") {
		return arg === undefined ? ok({ match, action: { kind } }) : usage(`${kind} takes no argument, got "${rule}"`);
	}
	if (kind === "status") {
		const code = Number(arg);
		if (arg === undefined || !Number.isInteger(code) || code < 100 || code > 599) {
			return usage(`status needs a code from 100 to 599, got "${rule}"`, "status:503");
		}
		return ok({ match, action: { kind: "status", code } });
	}
	if (kind === "delay") {
		const ms = arg === undefined ? undefined : parseDuration(arg);
		if (ms === undefined || !ms.success) return usage(`delay needs a duration, got "${rule}"`, "delay:2s");
		return ok({ match, action: { kind: "delay", ms: ms.data } });
	}
	return usage(`unknown fault "${rule}"`, "status:503, reset, delay:2s or blackhole");
}

/** `37.33,-122.03` */
export function parseLatLon(raw: string): Result<LatLon, UiError> {
	const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw);
	const lat = Number(m?.[1]);
	const lon = Number(m?.[2]);
	if (!m || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
		return usage(`invalid location "${raw}"`, "<lat>,<lon> with lat within 90 and lon within 180, e.g. 37.33,-122.03");
	}
	return ok({ lat, lon });
}

export function parseLatLons(raws: readonly string[]): Result<LatLon[], UiError> {
	const points: LatLon[] = [];
	for (const raw of raws) {
		const point = parseLatLon(raw);
		if (!point.success) return point;
		points.push(point.data);
	}
	return ok(points);
}

/** A positive number flag (`--speed`, `--interval`). */
export function parsePositive(raw: string | undefined, flag: string): Result<number | undefined, UiError> {
	if (raw === undefined) return ok(undefined);
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? ok(value) : usage(`${flag} must be a number above 0, got "${raw}"`);
}

export function parseScenario(raw: string): Result<LocationScenario, UiError> {
	const found = LOCATION_SCENARIOS.find((s) => s === raw);
	return found ? ok(found) : usage(`unknown scenario "${raw}"`, LOCATION_SCENARIOS.join(", "));
}
