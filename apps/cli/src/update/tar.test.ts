import { describe, expect, test } from "bun:test";
import { checkPlainTarball, extractFile } from "./tar";
import { makeTgz, paxPath } from "./tar.testing";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("extractFile", () => {
	test("returns one file's bytes from a gzipped tarball", () => {
		const tgz = makeTgz([
			{ name: "package/package.json", content: "{}" },
			{ name: "package/bin/warden", content: "BINARY".repeat(200) },
			{ name: "package/LICENSE", content: "MIT" },
		]);
		const result = extractFile(tgz, "package/bin/warden");
		expect(result.success).toBe(true);
		if (result.success) expect(text(result.data)).toBe("BINARY".repeat(200));
	});

	test("honours a pax path header", () => {
		const tgz = makeTgz([
			{ name: "PaxHeader", content: paxPath("package/bin/warden"), type: "x" },
			{ name: "truncated-name", content: "PAX-BINARY" },
		]);
		const result = extractFile(tgz, "package/bin/warden");
		expect(result.success && text(result.data)).toBe("PAX-BINARY");
	});

	test("missing entry → error naming it", () => {
		const result = extractFile(makeTgz([{ name: "package/package.json", content: "{}" }]), "package/bin/warden");
		expect(result).toEqual({ success: false, error: "package/bin/warden not found in tarball" });
	});

	test("not gzip → error", () => {
		const result = extractFile(new TextEncoder().encode("nope"), "package/bin/warden");
		expect(result.success).toBe(false);
	});
});

describe("checkPlainTarball", () => {
	test("files and directories at relative paths pass, pax and GNU long names included", () => {
		const tgz = makeTgz([
			{ name: "./", content: "", type: "5" },
			{ name: "./bin/", content: "", type: "5" },
			{ name: "./bin/tool", content: "x" },
			{ name: "pax_global_header", content: "52 comment=0000000000000000000000000000000000000000\n", type: "g" },
			{ name: "PaxHeader", content: paxPath("long/path/file"), type: "x" },
			{ name: "truncated", content: "y" },
			{ name: "././@LongLink", content: "another/long/path\0", type: "L" },
			{ name: "truncated-2", content: "z" },
		]);
		expect(checkPlainTarball(tgz)).toEqual({ success: true, data: undefined });
	});

	test("links and devices are refused by name", () => {
		for (const [type, kind] of [
			["1", "a hard link"],
			["2", "a symbolic link"],
			["3", "a character device"],
			["6", "a FIFO"],
		] as const) {
			const result = checkPlainTarball(makeTgz([{ name: "a/b", content: "", type }]));
			expect(result).toEqual({
				success: false,
				error: `tarball entry a/b is ${kind}: only regular files and directories are unpacked`,
			});
		}
	});

	test("absolute paths and .. segments are refused, also when a pax or long-name header carries them", () => {
		for (const name of ["/etc/x", "../x", "a/../../x"]) {
			for (const tgz of [
				makeTgz([{ name, content: "x" }]),
				makeTgz([
					{ name: "PaxHeader", content: paxPath(name), type: "x" },
					{ name: "innocent", content: "x" },
				]),
				makeTgz([
					{ name: "././@LongLink", content: `${name}\0`, type: "L" },
					{ name: "innocent", content: "x" },
				]),
			]) {
				expect(checkPlainTarball(tgz)).toEqual({
					success: false,
					error: `tarball entry ${name} is outside the archive root`,
				});
			}
		}
	});

	test("not gzip → error", () => {
		expect(checkPlainTarball(new TextEncoder().encode("nope")).success).toBe(false);
	});
});
