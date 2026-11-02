import { describe, expect, test } from "bun:test";
import { offerCandidateCount, summarizeStats } from "./whep-diagnostics.ts";

describe("summarizeStats", () => {
	test("picks inbound video counters and the nominated candidate pair", () => {
		const report = new Map<string, Record<string, unknown>>([
			["v", { type: "inbound-rtp", kind: "video", packetsReceived: 120, framesDecoded: 30, bytesReceived: 9000 }],
			["a", { type: "inbound-rtp", kind: "audio", packetsReceived: 5 }],
			["p0", { type: "candidate-pair", state: "failed", nominated: false }],
			["p1", { type: "candidate-pair", state: "succeeded", nominated: true }],
		]);
		expect(summarizeStats(report)).toEqual({
			video: { packetsReceived: 120, framesDecoded: 30, bytesReceived: 9000 },
			pair: "succeeded",
		});
	});

	test("reports nothing received when there is no inbound video yet", () => {
		expect(summarizeStats(new Map())).toEqual({ video: null, pair: null });
	});
});

describe("offerCandidateCount", () => {
	test("counts candidate lines in an SDP", () => {
		const sdp =
			"v=0\r\na=candidate:1 1 udp 1 10.0.0.1 5000 typ host\r\na=candidate:2 1 udp 1 1.2.3.4 5000 typ srflx\r\n";
		expect(offerCandidateCount(sdp)).toBe(2);
		expect(offerCandidateCount("v=0\r\n")).toBe(0);
	});
});
