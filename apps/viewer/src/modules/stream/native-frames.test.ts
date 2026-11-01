import { describe, expect, test } from "bun:test";
import { avcCodec, parseMessage, rtpToMicros } from "./native-frames.ts";

const bytes = (...b: number[]) => new Uint8Array(b).buffer;

describe("parseMessage", () => {
	test("reads a keyframe: kind, big-endian rtp timestamp, annex-b body", () => {
		const message = parseMessage(bytes(1, 0, 0, 0x01, 0x2c, 0, 0, 0, 1, 0x65));
		expect(message).toEqual({ kind: "frame", key: true, timestamp: 300, data: new Uint8Array([0, 0, 0, 1, 0x65]) });
	});

	test("reads a delta frame", () => {
		const message = parseMessage(bytes(0, 0, 0, 0, 1, 0x41));
		expect(message).toMatchObject({ kind: "frame", key: false, timestamp: 1 });
	});

	test("reads a state message", () => {
		expect(parseMessage(bytes(2, 0, 0, 0, 0, ...new TextEncoder().encode("connected")))).toEqual({
			kind: "state",
			state: "connected",
		});
	});

	test("rejects a short or unknown message", () => {
		expect(parseMessage(bytes(1, 0))).toBeNull();
		expect(parseMessage(bytes(9, 0, 0, 0, 0))).toBeNull();
	});
});

describe("avcCodec", () => {
	test("builds avc1.PPCCLL from the first SPS", () => {
		const annexb = new Uint8Array([
			0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0xaa, 0, 0, 1, 0x68, 0xce,
		]);
		expect(avcCodec(annexb)).toBe("avc1.42e01f");
	});

	test("is null without an SPS", () => {
		expect(avcCodec(new Uint8Array([0, 0, 0, 1, 0x65, 1]))).toBeNull();
	});
});

describe("rtpToMicros", () => {
	test("converts 90 kHz ticks since the first frame", () => {
		expect(rtpToMicros(90_000 + 1000, 1000)).toBe(1_000_000);
		expect(rtpToMicros(10, 0xffff_fff0)).toBe(Math.round((26 * 1_000_000) / 90_000));
	});
});
