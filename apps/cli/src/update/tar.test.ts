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

	test("an archive that cannot be read to its end is an error, not a missing file", () => {
		const tgz = makeTgz([{ name: "package/package.json", content: "{}", sizeField: base256(2) }]);
		const result = extractFile(tgz, "package/bin/warden");
		if (result.success) throw new Error("expected an error");
		expect(result.error).toContain("package/package.json");
		expect(result.error).toContain("size");
	});
});

/** A GNU base-256 size field: the high bit of the first byte set, the value in the bytes after it. */
function base256(size: number): Uint8Array {
	const field = new Uint8Array(12);
	field[0] = 0x80;
	field[11] = size;
	return field;
}

describe("checkPlainTarball", () => {
	const fail = (tgz: Uint8Array): string => {
		const result = checkPlainTarball(tgz);
		if (result.success) throw new Error("expected a refusal");
		return result.error;
	};

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

	test("a macOS framework's links pass: relative targets that stay inside the archive", () => {
		const tgz = makeTgz([
			{ name: "./", content: "", type: "5" },
			{ name: "./X.framework/", content: "", type: "5" },
			{ name: "./X.framework/X", content: "", type: "2", link: "Versions/Current/X" },
			{ name: "./X.framework/Resources", content: "", type: "2", link: "Versions/Current/Resources" },
			{ name: "./X.framework/Versions/", content: "", type: "5" },
			{ name: "./X.framework/Versions/Current", content: "", type: "2", link: "A" },
			{ name: "./X.framework/Versions/A/", content: "", type: "5" },
			{ name: "./X.framework/Versions/A/X", content: "binary" },
			{ name: "./X.framework/Versions/A/Resources/", content: "", type: "5" },
			{ name: "./X.framework/Versions/A/Resources/Info.plist", content: "plist" },
			{ name: "./X.framework/Versions/up", content: "", type: "2", link: "../../manifest.json" },
			{ name: "./manifest.json", content: "{}" },
		]);
		expect(checkPlainTarball(tgz)).toEqual({ success: true, data: undefined });
	});

	test("a link with an absolute target, or one that leaves the archive, is refused", () => {
		for (const link of ["/etc/hosts", "..", "../outside", "../../../etc/hosts", "a/../../../x", "sub/../x"]) {
			const error = fail(makeTgz([{ name: "./link", content: "", type: "2", link }]));
			expect(error).toBe(`tarball entry ./link links outside the archive (${link})`);
		}
		// one level down, `..` is the archive root itself: still inside
		expect(checkPlainTarball(makeTgz([{ name: "dir/link", content: "", type: "2", link: ".." }])).success).toBe(true);
		expect(fail(makeTgz([{ name: "dir/link", content: "", type: "2", link: "../.." }]))).toContain("links outside");
		expect(fail(makeTgz([{ name: "link", content: "", type: "2", link: "" }]))).toContain("links outside the archive");
	});

	test("a link target carried by a pax or GNU long-link header is the one checked", () => {
		const pax = makeTgz([
			{ name: "PaxHeader", content: paxPath("/etc/hosts", "linkpath"), type: "x" },
			{ name: "link", content: "", type: "2", link: "innocent" },
		]);
		expect(fail(pax)).toBe("tarball entry link links outside the archive (/etc/hosts)");
		const gnu = makeTgz([
			{ name: "././@LongLink", content: "../../x\0", type: "K" },
			{ name: "link", content: "", type: "2", link: "innocent" },
		]);
		expect(fail(gnu)).toBe("tarball entry link links outside the archive (../../x)");
	});

	test("no entry may sit below a link, whichever comes first in the archive", () => {
		for (const tgz of [
			makeTgz([
				{ name: "./a/link", content: "", type: "2", link: "." },
				{ name: "./a/link/file", content: "x" },
			]),
			makeTgz([
				{ name: "a/link/deeper/file", content: "x" },
				{ name: "a/link/", content: "", type: "2", link: "b" },
			]),
		]) {
			expect(fail(tgz)).toContain("is below the link a/link");
		}
	});

	test("hard links and devices are refused by name", () => {
		for (const [type, kind] of [
			["1", "a hard link"],
			["3", "a character device"],
			["6", "a FIFO"],
		] as const) {
			expect(fail(makeTgz([{ name: "a/b", content: "", type, link: "a/c" }]))).toBe(
				`tarball entry a/b is ${kind}: only files, directories and links inside the archive are unpacked`
			);
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
				expect(fail(tgz)).toBe(`tarball entry ${name} is outside the archive root`);
			}
		}
	});

	test("an entry whose size is not plain octal is refused, with everything after it unread", () => {
		const evil = { name: "evil", content: "", type: "2" as const, link: "/etc" };
		const binary = fail(makeTgz([{ name: "first", content: "xx", sizeField: base256(2) }, evil]));
		expect(binary).toBe("tarball entry first has a size field that is not octal");
		const garbage = fail(
			makeTgz([{ name: "first", content: "xx", sizeField: new TextEncoder().encode("0000002x\0") }, evil])
		);
		expect(garbage).toBe("tarball entry first has a size field that is not octal");
	});

	test("a pax size record is refused", () => {
		const error = fail(
			makeTgz([
				{ name: "PaxHeader", content: paxPath("1024", "size"), type: "x" },
				{ name: "file", content: "x" },
			])
		);
		expect(error).toBe("tarball entry PaxHeader carries a pax size record");
	});

	test("an archive cut short, or without its end-of-archive blocks, is refused", () => {
		expect(fail(makeTgz([{ name: "file", content: "x" }], { end: false }))).toBe(
			"tarball ends without its end-of-archive blocks"
		);
		const long = new TextEncoder().encode(`${(4096).toString(8).padStart(11, "0")}\0`);
		expect(fail(makeTgz([{ name: "file", content: "x", sizeField: long }]))).toBe(
			"tarball entry file is longer than the archive"
		);
	});

	test("not gzip → error", () => {
		expect(checkPlainTarball(new TextEncoder().encode("nope")).success).toBe(false);
	});
});
