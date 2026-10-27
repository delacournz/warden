import { describe, expect, test } from "bun:test";
import { classifyLink, eventPayload } from "./events";

const PAGE = "https://warden.co.nz/docs/quickstart";

describe("classifyLink", () => {
	test("calls a link to another host outbound, with its full URL", () => {
		expect(classifyLink("https://github.com/delacournz/warden", PAGE)).toEqual({
			name: "outbound",
			url: "https://github.com/delacournz/warden",
		});
	});

	test("calls a same-origin link to a file a download, by path", () => {
		expect(classifyLink("/llms.txt", PAGE)).toEqual({ name: "download", file: "/llms.txt" });
		expect(classifyLink("/docs/quickstart.md", PAGE)).toEqual({ name: "download", file: "/docs/quickstart.md" });
		expect(classifyLink("https://warden.co.nz/llms-full.txt?x=1", PAGE)).toEqual({
			name: "download",
			file: "/llms-full.txt",
		});
	});

	test("ignores ordinary navigation, fragments and non-http schemes", () => {
		expect(classifyLink("/docs/reference/cli", PAGE)).toBeNull();
		expect(classifyLink("#claim", PAGE)).toBeNull();
		expect(classifyLink("mailto:chris@delacour.co.nz", PAGE)).toBeNull();
	});

	test("ignores an href that is not a URL at all", () => {
		expect(classifyLink("http://", PAGE)).toBeNull();
	});
});

describe("eventPayload", () => {
	test("splits an event into a name and data", () => {
		expect(eventPayload({ name: "copy", what: "command" })).toEqual({ name: "copy", data: { what: "command" } });
		expect(eventPayload({ name: "search", query: "claim", results: 3 })).toEqual({
			name: "search",
			data: { query: "claim", results: 3 },
		});
	});
});
