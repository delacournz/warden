import { describe, expect, test } from "bun:test";
import { decodeControl, decodeData, encodeData, STREAM } from "./relay-protocol";

describe("relay frames", () => {
	test("a data frame carries its stream and channel, then the bytes", () => {
		const frame = encodeData(STREAM.stdout, 7, new TextEncoder().encode("hi"));
		expect([...frame.slice(0, 5)]).toEqual([1, 0, 0, 0, 7]);
		const back = decodeData(frame);
		expect(back?.stream).toBe(STREAM.stdout);
		expect(back?.ch).toBe(7);
		expect(new TextDecoder().decode(back?.payload)).toBe("hi");
		expect(decodeData(new Uint8Array([9, 0, 0, 0, 1]))).toBeUndefined();
		expect(decodeData(new Uint8Array([1, 0]))).toBeUndefined();
	});

	test("control frames: only the known shapes, every field checked", () => {
		expect(
			decodeControl('{"t":"open","ch":1,"cmd":["ls","--json"],"owner":{"machineId":"m1","user":"me@x.nz"}}')
		).toEqual({ t: "open", ch: 1, cmd: ["ls", "--json"], owner: { machineId: "m1", user: "me@x.nz" } });
		expect(decodeControl('{"t":"open","cmd":["ls"]}')).toEqual({ t: "open", cmd: ["ls"] });
		expect(decodeControl('{"t":"eof","ch":1}')).toEqual({ t: "eof", ch: 1 });
		expect(decodeControl('{"t":"exit","ch":1,"code":3}')).toEqual({ t: "exit", ch: 1, code: 3 });
		expect(decodeControl('{"t":"error","code":"HOST_OFFLINE","message":"down"}')).toEqual({
			t: "error",
			code: "HOST_OFFLINE",
			message: "down",
		});
		for (const bad of ['{"t":"open","ch":1,"cmd":"ls"}', '{"t":"exit","ch":1}', '{"t":"nope"}', "not json", "[]"]) {
			expect(decodeControl(bad)).toBeUndefined();
		}
	});
});
