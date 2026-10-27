import type { Fetch } from "@delacour/warden-e2e/devtools/devtools.types";
import { ok, type Result } from "@delacour/warden-types/result";

export type SourceMapErrorCode =
	| "invalid_map"
	| "fetch_failed"
	| "source_not_found"
	| "ambiguous_source"
	| "no_mapping";

export type SourceMapError = { code: SourceMapErrorCode; message: string };

const fail = (code: SourceMapErrorCode, message: string): { success: false; error: SourceMapError } => ({
	success: false,
	error: { code, message },
});

/** What the logpoints need of a Metro source map: the source paths and the raw VLQ `mappings` (decoded on demand). */
export type ParsedSourceMap = { sources: string[]; mappings: string };

/** One decoded mapping; every number 0-based. */
export type Segment = { genLine: number; genCol: number; source: number; origLine: number; origCol: number };

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT: ReadonlyMap<string, number> = new Map([...BASE64].map((char, index) => [char, index]));

/**
 * Decodes `mappings` (base64 VLQ, `;` between generated lines, `,` between segments), calling `visit` for every
 * segment that carries a source position; one-field segments (generated column only) are skipped. Throws on a
 * character outside the base64 alphabet.
 */
export function walkMappings(mappings: string, visit: (segment: Segment) => void): void {
	let genLine = 0;
	let genCol = 0;
	let source = 0;
	let origLine = 0;
	let origCol = 0;
	let at = 0;

	const readValue = (): number => {
		let value = 0;
		let shift = 0;
		for (;;) {
			const digit = DIGIT.get(mappings.charAt(at++));
			if (digit === undefined) throw new Error(`invalid VLQ character at ${at - 1}`);
			value += (digit & 31) * 2 ** shift;
			shift += 5;
			if ((digit & 32) === 0) break;
		}
		return value % 2 === 1 ? -(value - 1) / 2 : value / 2;
	};

	while (at < mappings.length) {
		const char = mappings.charAt(at);
		if (char === ";") {
			genLine++;
			genCol = 0;
			at++;
			continue;
		}
		if (char === ",") {
			at++;
			continue;
		}
		genCol += readValue();
		const more = at < mappings.length && mappings.charAt(at) !== "," && mappings.charAt(at) !== ";";
		if (!more) continue;
		source += readValue();
		origLine += readValue();
		origCol += readValue();
		visit({ genLine, genCol, source, origLine, origCol });
		// optional fifth field: the name index
		if (at < mappings.length && mappings.charAt(at) !== "," && mappings.charAt(at) !== ";") readValue();
	}
}

/** Parses a source map document (Metro emits plain v3 maps; index maps with `sections` are refused). */
export function parseSourceMap(text: string): Result<ParsedSourceMap, SourceMapError> {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return fail("invalid_map", "source map is not JSON");
	}
	if (typeof json !== "object" || json === null) return fail("invalid_map", "source map is not an object");
	const sources: unknown = "sources" in json ? json.sources : undefined;
	const mappings: unknown = "mappings" in json ? json.mappings : undefined;
	if ("sections" in json) return fail("invalid_map", "index source maps (sections) are not supported");
	if (!Array.isArray(sources) || !sources.every((s): s is string => typeof s === "string")) {
		return fail("invalid_map", "source map has no sources array");
	}
	if (typeof mappings !== "string") return fail("invalid_map", "source map has no mappings string");
	return ok({ sources, mappings });
}

/** `src/a.tsx` / `./src/a.tsx` / `/[metro-project]/src/a.tsx` as a comparable path without leading `./` or `/`. */
const normalize = (path: string): string => path.replace(/^\/?\[metro-project\]\//, "").replace(/^(\.\/|\/)+/, "");

/**
 * The index in `map.sources` for `file`. Rules: an exact match (after dropping a leading `./`, `/` or Metro's
 * `/[metro-project]/`) wins; else a source that ends with `/<file>` must be the only one; several is
 * `ambiguous_source` listing every candidate (add more leading directories to `file`).
 */
export function findSource(map: ParsedSourceMap, file: string): Result<number, SourceMapError> {
	const wanted = normalize(file);
	const exact = map.sources.flatMap((source, index) => (normalize(source) === wanted ? [index] : []));
	if (exact.length === 1 && exact[0] !== undefined) return ok(exact[0]);
	const matches = map.sources.flatMap((source, index) =>
		source === file || source.endsWith(`/${wanted}`) ? [index] : []
	);
	const [first, ...rest] = matches;
	if (first === undefined) return fail("source_not_found", `no source in the bundle's map matches ${file}`);
	if (rest.length > 0) {
		const listed = matches.map((index) => map.sources[index]).join(", ");
		return fail("ambiguous_source", `${file} matches ${matches.length} sources: ${listed}`);
	}
	return ok(first);
}

/** An original position (1-based, as in an editor) and the generated one it maps to (0-based, as CDP wants). */
export type ResolvedLocation = {
	source: string;
	/** the original position the mapping is actually at: later than asked when the asked line has no code */
	line: number;
	col: number;
	generatedLine: number;
	generatedColumn: number;
};

/** How many lines past an unmapped line (comment, blank, type-only) the breakpoint may snap to. */
const SNAP_LINES = 20;

/**
 * Original `file:line[:col]` → generated position. Takes the mappings on that original line (smallest column at or
 * after `col`, or the smallest column without `col`); with none, the next line with code within {@link SNAP_LINES}.
 * Among mappings of the same original position the earliest generated one wins.
 */
export function originalToGenerated(
	map: ParsedSourceMap,
	file: string,
	line: number,
	col?: number
): Result<ResolvedLocation, SourceMapError> {
	const found = findSource(map, file);
	if (!found.success) return found;
	const line0 = line - 1;
	const col0 = col === undefined ? 0 : col - 1;
	let best: Segment | undefined;
	const better = (a: Segment, b: Segment): boolean =>
		a.origLine !== b.origLine
			? a.origLine < b.origLine
			: a.origCol !== b.origCol
				? a.origCol < b.origCol
				: a.genLine !== b.genLine
					? a.genLine < b.genLine
					: a.genCol < b.genCol;
	try {
		walkMappings(map.mappings, (segment) => {
			if (segment.source !== found.data) return;
			if (segment.origLine < line0 || segment.origLine > line0 + SNAP_LINES) return;
			if (segment.origLine === line0 && segment.origCol < col0) return;
			if (best === undefined || better(segment, best)) best = segment;
		});
	} catch (error) {
		return fail("invalid_map", String(error));
	}
	const source = map.sources[found.data] ?? file;
	if (best === undefined)
		return fail("no_mapping", `${file}:${line} has no generated code (is it type-only or dead code?)`);
	return ok({
		source,
		line: best.origLine + 1,
		col: best.origCol + 1,
		generatedLine: best.genLine,
		generatedColumn: best.genCol,
	});
}

/** The bundle's source map URL on the Metro this CLI can reach (the device's `localhost` may not be ours). */
export function sourceMapLocation(
	bundleUrl: string,
	sourceMapURL: string | undefined,
	metroUrl: string
): { kind: "data"; text: string } | { kind: "url"; url: string } | undefined {
	if (!URL.canParse(bundleUrl)) return undefined;
	if (sourceMapURL?.startsWith("data:")) {
		const comma = sourceMapURL.indexOf(",");
		if (comma < 0) return undefined;
		const payload = sourceMapURL.slice(comma + 1);
		const base64 = sourceMapURL.slice(0, comma).includes(";base64");
		return {
			kind: "data",
			text: base64 ? Buffer.from(payload, "base64").toString("utf8") : decodeURIComponent(payload),
		};
	}
	const bundle = new URL(bundleUrl);
	const target =
		sourceMapURL !== undefined && sourceMapURL !== ""
			? new URL(sourceMapURL, bundle)
			: new URL(`${bundle.pathname.replace(/\.bundle$/, ".map")}${bundle.search}`, bundle);
	return { kind: "url", url: new URL(`${target.pathname}${target.search}`, metroUrl).toString() };
}

export type SourceMapCache = {
	/** the parsed map of a bundle, fetched on first use and kept until {@link SourceMapCache.invalidate} */
	get(bundleUrl: string, sourceMapURL?: string): Promise<Result<ParsedSourceMap, SourceMapError>>;
	/** forget a bundle's map (it was rebuilt or reloaded) */
	invalidate(bundleUrl: string): void;
};

/** Source maps fetched from `metroUrl` with `fetch`, one request per bundle URL until invalidated. */
export function createSourceMapCache(o: { metroUrl: string; fetch?: Fetch }): SourceMapCache {
	const doFetch: Fetch = o.fetch ?? ((input, init) => fetch(input, init));
	const maps = new Map<string, Promise<Result<ParsedSourceMap, SourceMapError>>>();

	const load = async (bundleUrl: string, sourceMapURL?: string): Promise<Result<ParsedSourceMap, SourceMapError>> => {
		const location = sourceMapLocation(bundleUrl, sourceMapURL, o.metroUrl);
		if (!location) return fail("fetch_failed", `cannot work out the source map URL of ${bundleUrl}`);
		if (location.kind === "data") return parseSourceMap(location.text);
		try {
			const response = await doFetch(location.url);
			if (!response.ok) return fail("fetch_failed", `${location.url} answered ${response.status}`);
			return parseSourceMap(await response.text());
		} catch (error) {
			return fail("fetch_failed", `${location.url}: ${String(error)}`);
		}
	};

	return {
		get(bundleUrl, sourceMapURL) {
			const cached = maps.get(bundleUrl);
			if (cached) return cached;
			const pending = load(bundleUrl, sourceMapURL).then((result) => {
				if (!result.success) maps.delete(bundleUrl);
				return result;
			});
			maps.set(bundleUrl, pending);
			return pending;
		},
		invalidate(bundleUrl) {
			maps.delete(bundleUrl);
		},
	};
}
