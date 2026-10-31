import type { LatLon } from "@delacour/warden-core/conditions/conditions.types";
import { err, ok, type Result } from "@delacour/warden-types/result";

/** Opening tags of the three GPX point kinds, with or without an XML namespace prefix. */
const POINT_TAG = /<(?:[\w-]+:)?(?:trkpt|rtept|wpt)\b([^>]*?)\/?>/gi;
const ATTR = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributes(raw: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of raw.matchAll(ATTR)) out.set((m[1] as string).toLowerCase(), (m[2] ?? m[3]) as string);
	return out;
}

function coordinate(value: string | undefined, limit: number): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const n = Number(value);
	return Number.isFinite(n) && Math.abs(n) <= limit ? n : undefined;
}

/**
 * Tolerant, dependency-free GPX reader: every `<trkpt>`, `<rtept>` and `<wpt>` with a valid `lat` and
 * `lon` attribute, in document order. Comments are dropped, a point with a bad or missing coordinate is
 * skipped, and truncated XML yields the points before the break. No points at all is an error.
 */
export function parseGpx(xml: string): Result<LatLon[]> {
	const text = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
	const points: LatLon[] = [];
	for (const match of text.matchAll(POINT_TAG)) {
		const attrs = attributes(match[1] as string);
		const lat = coordinate(attrs.get("lat"), 90);
		const lon = coordinate(attrs.get("lon"), 180);
		if (lat !== undefined && lon !== undefined) points.push({ lat, lon });
	}
	return points.length > 0 ? ok(points) : err("GPX has no <trkpt>, <rtept> or <wpt> with a valid lat/lon");
}
