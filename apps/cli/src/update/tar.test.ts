import { describe, expect, test } from "bun:test";
import { tarHelpers } from "./tar";
import { tarTesting } from "./tar.testing";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("extractFile", () => {
	test("returns one file's bytes from a gzipped tarball", () => {
		const tgz = tarTesting.makeTgz([
			{ name: "package/package.json", content: "{}" },
			{ name: "package/bin/warden", content: "BINARY".repeat(200) },
			{ name: "package/LICENSE", content: "MIT" },
		]);
		const result = tarHelpers.extractFile(tgz, "package/bin/warden");
		expect(result.success).toBe(true);
		if (result.success) expect(text(result.data)).toBe("BINARY".repeat(200));
	});

	test("honours a pax path header", () => {
		const tgz = tarTesting.makeTgz([
			{ name: "PaxHeader", content: tarTesting.paxPath("package/bin/warden"), type: "x" },
			{ name: "truncated-name", content: "PAX-BINARY" },
		]);
		const result = tarHelpers.extractFile(tgz, "package/bin/warden");
		expect(result.success && text(result.data)).toBe("PAX-BINARY");
	});

	test("missing entry → error naming it", () => {
		const result = tarHelpers.extractFile(
			tarTesting.makeTgz([{ name: "package/package.json", content: "{}" }]),
			"package/bin/warden"
		);
		expect(result).toEqual({ success: false, error: "package/bin/warden not found in tarball" });
	});

	test("not gzip → error", () => {
		const result = tarHelpers.extractFile(new TextEncoder().encode("nope"), "package/bin/warden");
		expect(result.success).toBe(false);
	});
});
