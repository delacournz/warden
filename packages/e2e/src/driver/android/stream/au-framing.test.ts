import { describe, expect, test } from "bun:test";
import { AnnexBSplitter, AU_HEADER_LENGTH, AuFlag, AuReader, frameUnit, nalTypes } from "./au-framing";

const sc = [0, 0, 0, 1];
const SPS = [...sc, 0x67, 0x42, 0xc0, 0x1f];
const PPS = [...sc, 0x68, 0xce, 0x3c, 0x80];
/** an IDR slice whose header starts with first_mb_in_slice = 0 (the ue(v) `1` bit) */
const IDR = [...sc, 0x65, 0x88, 0x84, 0x21];
const P0 = [...sc, 0x41, 0x9a, 0x02];
const P1 = [...sc, 0x41, 0x9a, 0x03];
/** a second slice of the same picture: first_mb_in_slice != 0 (top bit 0) */
const P1b = [...sc, 0x41, 0x40, 0x11];

describe("frameUnit", () => {
	test("u32 length, u8 flags, u64 pts_us, big-endian, then the Annex-B bytes (the iOS helper's framing)", () => {
		const framed = frameUnit({
			data: new Uint8Array([9, 8]),
			flags: AuFlag.key | AuFlag.config,
			ptsMicros: 0x0a0b0c0d0e0f1011n,
		});
		expect([...framed]).toEqual([0, 0, 0, 2, 0b11, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 9, 8]);
		expect(AU_HEADER_LENGTH).toBe(13);
	});
});

describe("AuReader", () => {
	test("reassembles units split across chunks at any byte", () => {
		const a = frameUnit({ data: new Uint8Array([1, 2, 3]), flags: AuFlag.key, ptsMicros: 5n });
		const b = frameUnit({ data: new Uint8Array([4]), flags: 0, ptsMicros: 7n });
		const all = new Uint8Array([...a, ...b]);
		const reader = new AuReader();
		const got = [];
		for (let i = 0; i < all.length; i += 4) got.push(...reader.push(all.subarray(i, i + 4)));
		expect(got).toEqual([
			{ data: new Uint8Array([1, 2, 3]), flags: AuFlag.key, ptsMicros: 5n },
			{ data: new Uint8Array([4]), flags: 0, ptsMicros: 7n },
		]);
	});
});

describe("nalTypes", () => {
	test("3- and 4-byte start codes", () => {
		expect(nalTypes(new Uint8Array([...SPS, 0, 0, 1, 0x68, 0xce, ...IDR]))).toEqual([7, 8, 5]);
	});
});

describe("AnnexBSplitter", () => {
	test("SPS+PPS+IDR is one keyframe unit with config; a picture is held until the next one starts, or a drain", () => {
		const splitter = new AnnexBSplitter();
		const units = splitter.push(new Uint8Array([...SPS, ...PPS, ...IDR, ...P0, ...P1]));
		expect(units.map((u) => ({ flags: u.flags, nals: nalTypes(u.data) }))).toEqual([
			{ flags: AuFlag.key | AuFlag.config, nals: [7, 8, 5] },
		]);
		expect([...(units[0]?.data ?? [])]).toEqual([...SPS, ...PPS, ...IDR]);
		expect(splitter.drain().map((u) => [...u.data])).toEqual([P0, P1]);
		expect(splitter.drain()).toEqual([]);
	});

	test("a drain right after a whole frame emits it with no wait for the next one", () => {
		const splitter = new AnnexBSplitter();
		expect(splitter.push(new Uint8Array([...SPS, ...PPS, ...IDR]))).toEqual([]);
		expect(splitter.drain().map((u) => u.flags)).toEqual([AuFlag.key | AuFlag.config]);
		splitter.push(new Uint8Array(P0));
		expect(splitter.drain().map((u) => [...u.data])).toEqual([P0]);
		expect(splitter.splitErrors).toBe(0);
	});

	test("bytes that continue a drained NAL (no start code) are counted as a split error and dropped", () => {
		const splitter = new AnnexBSplitter();
		splitter.push(new Uint8Array(P0.slice(0, 5)));
		splitter.drain();
		expect(splitter.push(new Uint8Array([0x77, ...P1]))).toEqual([]);
		expect(splitter.splitErrors).toBe(1);
		expect(splitter.drain().map((u) => [...u.data])).toEqual([P1]);
	});

	test("bytes split anywhere (inside a start code too) give the same units", () => {
		const stream = new Uint8Array([...SPS, ...PPS, ...IDR, ...P0, ...P1, ...P0]);
		const one = new AnnexBSplitter();
		const whole = [...one.push(stream), ...one.drain()].map((u) => [...u.data]);
		expect(whole).toEqual([[...SPS, ...PPS, ...IDR], P0, P1, P0]);
		for (const step of [1, 2, 3, 5, 7]) {
			const splitter = new AnnexBSplitter();
			const got: number[][] = [];
			for (let i = 0; i < stream.length; i += step)
				got.push(...splitter.push(stream.subarray(i, i + step)).map((u) => [...u.data]));
			got.push(...splitter.drain().map((u) => [...u.data]));
			expect(got).toEqual(whole);
		}
	});

	test("a picture of several slices stays one unit", () => {
		const splitter = new AnnexBSplitter();
		const units = [...splitter.push(new Uint8Array([...P1, ...P1b, ...P0])), ...splitter.drain()];
		expect(units.map((u) => nalTypes(u.data))).toEqual([[1, 1], [1]]);
	});

	test("leading bytes before the first start code are dropped", () => {
		const splitter = new AnnexBSplitter();
		const units = [...splitter.push(new Uint8Array([0xff, 0xee, ...SPS, ...PPS, ...IDR, ...P0])), ...splitter.drain()];
		expect(nalTypes(units[0]?.data ?? new Uint8Array())).toEqual([7, 8, 5]);
	});
});
