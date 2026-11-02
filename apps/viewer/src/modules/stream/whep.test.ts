import { describe, expect, test } from "bun:test";
import { backoffDelay, candidateFragment } from "./whep.ts";

const offer = [
	"v=0",
	"o=- 1 2 IN IP4 127.0.0.1",
	"s=-",
	"t=0 0",
	"m=audio 9 UDP/TLS/RTP/SAVPF 111",
	"a=ice-ufrag:abcd",
	"a=ice-pwd:secretpwd",
	"a=mid:0",
	"m=video 9 UDP/TLS/RTP/SAVPF 96",
	"a=ice-ufrag:abcd",
	"a=ice-pwd:secretpwd",
	"a=mid:1",
	"",
].join("\r\n");

describe("candidateFragment", () => {
	test("builds an RFC 8840 fragment with the matching media section", () => {
		const fragment = candidateFragment(
			{ candidate: "candidate:1 1 udp 2113937151 10.0.0.2 5000 typ host", sdpMid: "1", usernameFragment: "abcd" },
			offer
		);
		expect(fragment).toBe(
			[
				"a=ice-ufrag:abcd",
				"a=ice-pwd:secretpwd",
				"m=video 9 RTP/AVP 0",
				"a=mid:1",
				"a=candidate:1 1 udp 2113937151 10.0.0.2 5000 typ host",
				"",
			].join("\r\n")
		);
	});

	test("falls back to the sdp ufrag when the candidate has none", () => {
		const fragment = candidateFragment(
			{ candidate: "candidate:2 1 udp 1 10.0.0.2 1 typ host", sdpMid: "0", usernameFragment: null },
			offer
		);
		expect(fragment).toContain("a=ice-ufrag:abcd");
		expect(fragment).toContain("m=audio 9 RTP/AVP 0");
	});

	test("returns null for an empty candidate or an unknown mid", () => {
		expect(candidateFragment({ candidate: "", sdpMid: "1", usernameFragment: null }, offer)).toBeNull();
		expect(candidateFragment({ candidate: "candidate:1", sdpMid: "9", usernameFragment: null }, offer)).toBeNull();
	});
});

describe("backoffDelay", () => {
	test("doubles from one second and caps at fifteen", () => {
		expect([0, 1, 2, 3, 4, 5, 9].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
	});
});
