import type { TraceMap } from "@jridgewell/trace-mapping";
import { isBundleUrl, toNormalBundleUrl } from "./bundle-url";
import type { CallFrame } from "./cpu-profile";
import type { JsCdp, JsResult } from "./js.types";
import { jsOk } from "./js.types";

/** A source map bigger than this is refused (a hostile or broken server must not fill memory). */
export const MAX_SOURCE_MAP_BYTES = 64 * 1024 * 1024;

export type ScriptInfo = { scriptId: string; url: string; sourceMapURL: string | undefined };

/** One `Debugger.scriptParsed` event, or undefined when it has no usable id. */
export function parseScriptParsed(params: unknown): ScriptInfo | undefined {
	if (typeof params !== "object" || params === null) return undefined;
	const { scriptId, url, sourceMapURL } = params as Record<string, unknown>;
	if (typeof scriptId !== "string" && typeof scriptId !== "number") return undefined;
	return {
		scriptId: String(scriptId),
		url: typeof url === "string" ? url : "",
		sourceMapURL: typeof sourceMapURL === "string" && sourceMapURL !== "" ? sourceMapURL : undefined,
	};
}

export type ScriptCollector = { scripts: Map<string, ScriptInfo>; dispose: () => void };

/**
 * `Debugger.enable` replays every script already parsed, so a collector started after the bundle loaded still sees
 * it. Subscribe first, then enable.
 */
export async function collectScripts(cdp: JsCdp): Promise<ScriptCollector> {
	const scripts = new Map<string, ScriptInfo>();
	const off = cdp.onCdp("Debugger.scriptParsed", (params) => {
		const script = parseScriptParsed(params);
		if (script !== undefined) scripts.set(script.scriptId, script);
	});
	await cdp.send("Debugger.enable");
	return {
		scripts,
		dispose: () => {
			off();
			void cdp.send("Debugger.disable");
		},
	};
}

/** Hosts an emulator or simulator uses to say "the machine running Metro". */
const HOST_ALIASES = new Set(["localhost", "127.0.0.1", "[::1]", "10.0.2.2", "10.0.3.2"]);

const portOf = (url: URL): string => url.port || (url.protocol === "https:" ? "443" : "80");

export type MapUrl =
	| { kind: "fetch"; url: string }
	| { kind: "inline"; text: string }
	| { kind: "refused"; reason: string };

function decodeDataMap(declared: string): MapUrl {
	const comma = declared.indexOf(",");
	if (comma < 0) return { kind: "refused", reason: "malformed data: source map" };
	const body = declared.slice(comma + 1);
	try {
		const text = /;base64$/i.test(declared.slice(0, comma))
			? Buffer.from(body, "base64").toString("utf8")
			: decodeURIComponent(body);
		return { kind: "inline", text };
	} catch {
		return { kind: "refused", reason: "undecodable data: source map" };
	}
}

/**
 * `sourceMapURL`, else Metro's convention: `index.bundle?…` has its map at `index.map?…`. Hermes reports the
 * JSC-safe `index.bundle//&…` form React Native loads, so the URL is normalised first.
 */
function declaredMapUrl(script: ScriptInfo): string | undefined {
	if (script.sourceMapURL !== undefined && script.sourceMapURL !== "") return script.sourceMapURL;
	if (!isBundleUrl(script.url)) return undefined;
	return toNormalBundleUrl(script.url).replace(/\.bundle(\?|$)/, ".map$1");
}

/**
 * Where a script's source map lives, and only if that is Metro (SSRF guard: a `sourceMapURL` is app-controlled).
 * The map must be on Metro's host:port; the same port on a loopback or emulator alias of the host (`10.0.2.2`,
 * what the app dials) is rewritten onto Metro's own origin. Anything else is refused. A `data:` map is decoded
 * locally. With no `sourceMapURL`, Metro's convention applies: `index.bundle?…` has its map at `index.map?…`.
 */
export function resolveMapUrl(script: ScriptInfo, metroUrl: string): MapUrl {
	if (!URL.canParse(metroUrl)) return { kind: "refused", reason: `bad Metro URL ${metroUrl}` };
	const metro = new URL(metroUrl);
	const declared = declaredMapUrl(script);
	if (declared === undefined) return { kind: "refused", reason: "script has no sourceMapURL" };
	if (declared.startsWith("data:")) return decodeDataMap(declared);
	const base = URL.canParse(script.url) ? script.url : metro.origin;
	if (!URL.canParse(declared, base)) return { kind: "refused", reason: `unparseable sourceMapURL ${declared}` };
	const target = new URL(declared, base);
	if (target.protocol !== "http:" && target.protocol !== "https:") {
		return { kind: "refused", reason: `source map scheme ${target.protocol} is not fetched` };
	}
	if (target.host === metro.host) return { kind: "fetch", url: target.href };
	if (portOf(target) === portOf(metro) && HOST_ALIASES.has(target.hostname)) {
		return { kind: "fetch", url: `${metro.origin}${target.pathname}${target.search}` };
	}
	return { kind: "refused", reason: `source map host ${target.host} is not Metro (${metro.host})` };
}

/** Fetch a source map's text, at most `maxBytes` of it (the default one streams and aborts past the cap). */
export type MapFetch = (url: string, maxBytes: number) => Promise<JsResult<string>>;

export type ResolvedFrame = {
	/** original file (project-relative when `projectRoot` was given); undefined when the frame is unmapped */
	source: string | undefined;
	line: number;
	column: number;
	name: string | undefined;
};

export type FrameResolver = (frame: CallFrame) => ResolvedFrame;

export type SourceMaps = {
	resolve: FrameResolver;
	/** how many distinct maps loaded */
	loaded: number;
	warnings: string[];
};

const identity = (frame: CallFrame): ResolvedFrame => ({
	source: undefined,
	line: (frame.lineNumber ?? 0) + 1,
	column: (frame.columnNumber ?? 0) + 1,
	name: undefined,
});

/** `file:///a/b` and `/a/b` → `/a/b`; relative to `projectRoot` when it contains it. */
export function normalizeSource(source: string, projectRoot: string | undefined): string {
	let path = source.startsWith("file://") ? source.slice("file://".length) : source;
	if (projectRoot !== undefined) {
		const root = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
		if (path.startsWith(root)) path = path.slice(root.length);
	}
	return path;
}

type MapCache = Map<string, TraceMap | undefined>;

/** The `TraceMap` for one script (fetched at most once per distinct map url), or a warning why not. */
async function loadMap(
	script: ScriptInfo,
	cache: MapCache,
	warnings: string[],
	options: { metroUrl: string; fetchMap: MapFetch },
	TraceMapClass: typeof TraceMap
): Promise<TraceMap | undefined> {
	const target = resolveMapUrl(script, options.metroUrl);
	if (target.kind === "refused") {
		warnings.push(`${script.url || script.scriptId}: ${target.reason}`);
		return undefined;
	}
	const key = target.kind === "fetch" ? target.url : `inline:${script.scriptId}`;
	if (cache.has(key)) return cache.get(key);
	const text = target.kind === "inline" ? jsOk(target.text) : await options.fetchMap(target.url, MAX_SOURCE_MAP_BYTES);
	let map: TraceMap | undefined;
	if (!text.success) warnings.push(`${key}: ${text.error.message}`);
	else if (text.data.length > MAX_SOURCE_MAP_BYTES) {
		warnings.push(`${key}: source map is over ${MAX_SOURCE_MAP_BYTES / 1024 / 1024}MiB`);
	} else {
		try {
			map = new TraceMapClass(text.data);
		} catch {
			warnings.push(`${key}: not a valid source map`);
		}
	}
	cache.set(key, map);
	return map;
}

/**
 * Load the source maps of the scripts the profile's frames reference (one fetch per distinct map URL) and return a
 * resolver for a frame (0-based `lineNumber` / `columnNumber`). A map that is refused, too big or unparseable is a
 * warning, and its frames stay unmapped. `trace-mapping` loads on first use.
 */
export async function loadSourceMaps(
	frames: readonly CallFrame[],
	scripts: ReadonlyMap<string, ScriptInfo>,
	options: { metroUrl: string | undefined; fetchMap: MapFetch; projectRoot?: string }
): Promise<SourceMaps> {
	const { metroUrl } = options;
	if (metroUrl === undefined) {
		return { resolve: identity, loaded: 0, warnings: ["no Metro URL: frames are not source-mapped"] };
	}
	const { TraceMap: TraceMapClass, originalPositionFor } = await import("@jridgewell/trace-mapping");
	const byUrl = new Map<string, ScriptInfo>();
	for (const script of scripts.values()) if (script.url !== "") byUrl.set(script.url, script);
	const scriptOf = (frame: CallFrame): ScriptInfo | undefined =>
		scripts.get(String(frame.scriptId)) ?? byUrl.get(frame.url);

	const warnings: string[] = [];
	const cache: MapCache = new Map();
	const mapOf = new Map<string, TraceMap>();
	const wanted = new Map<string, ScriptInfo>();
	for (const frame of frames) {
		const script = scriptOf(frame);
		if (script !== undefined) wanted.set(script.scriptId, script);
	}
	for (const script of wanted.values()) {
		const map = await loadMap(script, cache, warnings, { metroUrl, fetchMap: options.fetchMap }, TraceMapClass);
		if (map !== undefined) mapOf.set(script.scriptId, map);
	}
	const resolve: FrameResolver = (frame) => {
		const script = scriptOf(frame);
		const map = script === undefined ? undefined : mapOf.get(script.scriptId);
		if (map === undefined) return identity(frame);
		const original = originalPositionFor(map, { line: (frame.lineNumber ?? 0) + 1, column: frame.columnNumber ?? 0 });
		if (original.source === null) return identity(frame);
		return {
			source: normalizeSource(original.source, options.projectRoot),
			line: original.line ?? 0,
			column: (original.column ?? 0) + 1,
			name: original.name ?? undefined,
		};
	};
	return { resolve, loaded: new Set(mapOf.values()).size, warnings };
}
