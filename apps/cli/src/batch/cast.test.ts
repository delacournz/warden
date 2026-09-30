import { describe, expect, test } from "bun:test";
import { createCast } from "./cast";

describe("asciicast v2 writer", () => {
	test("header line + [seconds, 'o', data] events with CRLF newlines", () => {
		const cast = createCast({ width: 80, height: 5, startedAt: 1_700_000_000_000 });
		cast.write(1_700_000_000_000, "hello\n");
		cast.write(1_700_000_001_500, "\u001b[1Aworld\r\n");
		const [header, ...events] = cast.text().trimEnd().split("\n");
		expect(JSON.parse(header ?? "")).toEqual({
			version: 2,
			width: 80,
			height: 5,
			timestamp: 1_700_000_000,
			env: { TERM: "xterm-256color", SHELL: "/bin/zsh" },
		});
		expect(events.map((e) => JSON.parse(e))).toEqual([
			[0, "o", "hello\r\n"],
			[1.5, "o", "\u001b[1Aworld\r\n"],
		]);
	});

	test("height grows to the tallest frame seen", () => {
		const cast = createCast({ width: 80, height: 2, startedAt: 0 });
		cast.resizeTo(7);
		cast.resizeTo(4);
		expect(JSON.parse(cast.text().split("\n")[0] ?? "").height).toBe(7);
	});
});
