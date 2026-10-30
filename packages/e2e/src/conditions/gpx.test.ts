import { describe, expect, test } from "bun:test";
import { parseGpx } from "./gpx";

describe("parseGpx", () => {
	test("track points in document order", () => {
		const xml = `<?xml version="1.0"?><gpx><trk><trkseg>
			<trkpt lat="37.33" lon="-122.03"><ele>12.5</ele><time>2024-01-01T00:00:00Z</time></trkpt>
			<trkpt lat="37.34" lon="-122.04"/>
		</trkseg></trk></gpx>`;
		expect(parseGpx(xml)).toEqual({
			success: true,
			data: [
				{ lat: 37.33, lon: -122.03 },
				{ lat: 37.34, lon: -122.04 },
			],
		});
	});

	test("route points and waypoints, any attribute order and quote style", () => {
		const xml = `<gpx><wpt lon='1.5' lat='2.5'/><rte><rtept lat="3" lon="4"></rtept></rte></gpx>`;
		const parsed = parseGpx(xml);
		expect(parsed.success && parsed.data).toEqual([
			{ lat: 2.5, lon: 1.5 },
			{ lat: 3, lon: 4 },
		]);
	});

	test("skips malformed points but keeps the good ones", () => {
		const xml = `<gpx><trkpt lat="abc" lon="1"/><trkpt lat="1"/><trkpt lat="91" lon="0"/><trkpt lat="5" lon="6"/></gpx>`;
		const parsed = parseGpx(xml);
		expect(parsed.success && parsed.data).toEqual([{ lat: 5, lon: 6 }]);
	});

	test("tolerates namespaces, comments and unclosed junk", () => {
		const xml = `<gpx:gpx xmlns:gpx="x"><!-- <trkpt lat="9" lon="9"/> --><gpx:trkpt lat="7" lon="8"><ele>1</ele></gpx:trkpt><trkpt lat="1" lon=`;
		const parsed = parseGpx(xml);
		expect(parsed.success && parsed.data).toEqual([{ lat: 7, lon: 8 }]);
	});

	test("no points is an error", () => {
		const parsed = parseGpx("<gpx></gpx>");
		expect(parsed.success).toBe(false);
		expect(parseGpx("not xml at all").success).toBe(false);
		expect(parseGpx("").success).toBe(false);
	});
});
