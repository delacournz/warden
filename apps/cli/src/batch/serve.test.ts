import { describe, expect, test } from "bun:test";
import { parseReadySpec } from "./serve";

describe("parseReadySpec", () => {
	test("http(s)://, tcp:PORT, tcp:HOST:PORT, file:PATH", () => {
		expect(parseReadySpec("http://localhost:8091/status", "/w")).toEqual({
			success: true,
			data: { kind: "http", url: "http://localhost:8091/status" },
		});
		expect(parseReadySpec("https://x.test", "/w")).toMatchObject({ data: { kind: "http" } });
		expect(parseReadySpec("tcp:8091", "/w")).toEqual({
			success: true,
			data: { kind: "tcp", host: "127.0.0.1", port: 8091 },
		});
		expect(parseReadySpec("tcp:0.0.0.0:80", "/w")).toMatchObject({ data: { host: "0.0.0.0", port: 80 } });
		expect(parseReadySpec("file:tmp/ready", "/w")).toEqual({
			success: true,
			data: { kind: "file", path: "/w/tmp/ready" },
		});
		expect(parseReadySpec("file:/abs", "/w")).toMatchObject({ data: { path: "/abs" } });
	});

	test("anything else is an error", () => {
		for (const bad of ["", "8091", "tcp:", "tcp:x", "tcp:70000", "file:", "ftp://x"]) {
			expect(parseReadySpec(bad, "/w").success).toBe(false);
		}
	});
});
