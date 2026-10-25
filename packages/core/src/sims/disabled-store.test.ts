import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_DISABLED_STORE_ROOT,
	disabledLabels,
	disabledStorePath,
	disabledStoreRoot,
	encodeDisabledStore,
	parseDisabledStore,
	readDisabledStore,
	writeDisabledStore,
} from "./disabled-store";

const UDID = "032B72F3-B8F9-4603-80F8-7113577664B5";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.newsd</key>
	<true/>
	<key>com.apple.somethingd</key>
	<false/>
</dict>
</plist>
`;

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "warden-disabled-store-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("paths", () => {
	test("default root and path shape", () => {
		expect(DEFAULT_DISABLED_STORE_ROOT).toBe("/private/var/tmp");
		expect(disabledStorePath(UDID)).toBe(`/private/var/tmp/com.apple.CoreSimulator.SimDevice.${UDID}/disabled.plist`);
		expect(disabledStorePath(UDID, "/x")).toBe(`/x/com.apple.CoreSimulator.SimDevice.${UDID}/disabled.plist`);
	});

	test("env root override", () => {
		expect(disabledStoreRoot({})).toBe("/private/var/tmp");
		expect(disabledStoreRoot({ WARDEN_SIM_LAUNCHD_STORE_ROOT: "/tmp/r" })).toBe("/tmp/r");
		expect(disabledStoreRoot({ WARDEN_SIM_LAUNCHD_STORE_ROOT: "" })).toBe("/private/var/tmp");
	});
});

describe("parse / encode", () => {
	test("parses the sample", () => {
		const m = parseDisabledStore(SAMPLE);
		expect([...m]).toEqual([
			["com.apple.newsd", true],
			["com.apple.somethingd", false],
		]);
	});

	test("ignores string values, comments and tolerates whitespace", () => {
		const xml = `<plist><dict><!-- c --><key>a</key><string>x</string>
<key>b</key>   <true/>
<key> c </key><false />
<key>d</key><integer>1</integer></dict></plist>`;
		expect([...parseDisabledStore(xml)]).toEqual([
			["b", true],
			[" c ", false],
		]);
	});

	test("decodes entities and round-trips", () => {
		const xml = `<dict><key>a&amp;b&lt;c&gt;&quot;d&apos;</key><true/></dict>`;
		const m = parseDisabledStore(xml);
		expect([...m.keys()]).toEqual([`a&b<c>"d'`]);
		expect(parseDisabledStore(encodeDisabledStore(m))).toEqual(m);
	});

	test("encode sorts, escapes and matches the plist shape", () => {
		const out = encodeDisabledStore(
			new Map([
				["z.last", true],
				["a&b", false],
			])
		);
		expect(out).toContain("\t<key>a&amp;b</key>\n\t<false/>\n\t<key>z.last</key>\n\t<true/>\n</dict>\n</plist>\n");
		expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist')).toBe(true);
	});

	test("encode of sample (sorted) equals sample", () => {
		expect(encodeDisabledStore(parseDisabledStore(SAMPLE))).toBe(SAMPLE);
	});

	test("idempotent", () => {
		const once = encodeDisabledStore(
			new Map([
				["b", true],
				["a", false],
				["c&d", true],
			])
		);
		expect(encodeDisabledStore(parseDisabledStore(once))).toBe(once);
	});

	test("disabledLabels returns only true entries", () => {
		expect(disabledLabels(parseDisabledStore(SAMPLE))).toEqual(new Set(["com.apple.newsd"]));
	});
});

describe("read", () => {
	test("missing file is empty success", async () => {
		const r = await readDisabledStore(UDID, root);
		expect(r).toEqual({ success: true, data: new Map() });
	});

	test("garbage is an error naming the path", async () => {
		const path = disabledStorePath(UDID, root);
		const w = await writeDisabledStore(UDID, { disable: ["x"], enable: [] }, root);
		expect(w.success).toBe(true);
		await Bun.write(path, "this is not a plist");
		const r = await readDisabledStore(UDID, root);
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error).toContain(path);
	});
});

describe("write", () => {
	test("creates dir and file 0644, no temp left", async () => {
		const r = await writeDisabledStore(UDID, { disable: ["b", "a"], enable: [] }, root);
		expect(r.success).toBe(true);
		const path = disabledStorePath(UDID, root);
		if (r.success) expect(r.data).toEqual({ path, entries: 2 });
		expect((await stat(path)).mode & 0o777).toBe(0o644);
		const files = await readdir(join(path, ".."));
		expect(files.filter((f) => f.startsWith("disabled.plist."))).toEqual([]);
		expect(files).toEqual(["disabled.plist"]);
		expect(await readFile(path, "utf8")).toContain("<key>a</key>\n\t<true/>\n\t<key>b</key>");
	});

	test("merge preserves runtime false and unmanaged true", async () => {
		const path = disabledStorePath(UDID, root);
		await writeDisabledStore(UDID, { disable: [], enable: [] }, root);
		await Bun.write(
			path,
			encodeDisabledStore(
				new Map([
					["runtime.false", false],
					["unmanaged.true", true],
				])
			)
		);
		const r = await writeDisabledStore(UDID, { disable: ["ours"], enable: [] }, root);
		expect(r.success).toBe(true);
		const read = await readDisabledStore(UDID, root);
		expect(read.success && [...read.data]).toEqual([
			["ours", true],
			["runtime.false", false],
			["unmanaged.true", true],
		]);
	});

	test("enable flips to false, not deletion", async () => {
		await writeDisabledStore(UDID, { disable: ["x", "y"], enable: [] }, root);
		const r = await writeDisabledStore(UDID, { disable: [], enable: ["x", "never.seen"] }, root);
		expect(r.success && r.data.entries).toBe(3);
		const read = await readDisabledStore(UDID, root);
		expect(read.success && [...read.data]).toEqual([
			["never.seen", false],
			["x", false],
			["y", true],
		]);
	});

	test("failure returns err and leaves no temp", async () => {
		const blocker = join(root, `com.apple.CoreSimulator.SimDevice.${UDID}`);
		await Bun.write(blocker, "i am a file, not a dir");
		const r = await writeDisabledStore(UDID, { disable: ["x"], enable: [] }, root);
		expect(r.success).toBe(false);
	});
});
