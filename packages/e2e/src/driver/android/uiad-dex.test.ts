import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	javaSources,
	readConstants,
	renderGenerated,
	SOURCE_DIR,
	sourceHash,
} from "../../../native/android/scripts/build";
import { UIAD_DEX } from "./uiad-dex.generated";
import { UIAD_PROTOCOL } from "./uiad-protocol";

describe("the generated dex module", () => {
	test("is built from the Java sources that are checked in", async () => {
		const sources = await javaSources(SOURCE_DIR);
		expect(sources.length).toBeGreaterThan(0);
		// when this fails: `bun run --cwd packages/e2e android:emit` (needs the Android SDK build-tools), commit the result
		expect<string>(UIAD_DEX.sourceSha256).toBe(sourceHash(SOURCE_DIR, sources));
	});

	test("names the protocol and version Main.java declares, and the client speaks that protocol", () => {
		const main = readFileSync(join(SOURCE_DIR, "nz/co/delacour/warden/uiad/Main.java"), "utf8");
		expect(readConstants(main)).toEqual({ protocol: UIAD_DEX.protocol, version: UIAD_DEX.version });
		expect(UIAD_DEX.protocol).toBe(UIAD_PROTOCOL);
	});

	test("carries a dex whose size and hash are the ones it declares", () => {
		const dex = Buffer.from(UIAD_DEX.base64, "base64");
		expect(dex.length).toBe(UIAD_DEX.bytes);
		expect(createHash("sha256").update(dex).digest("hex")).toBe(UIAD_DEX.dexSha256);
		expect(dex.subarray(0, 4).toString("latin1")).toBe("dex\n");
	});
});

describe("renderGenerated", () => {
	test("writes the module the driver imports", () => {
		const text = renderGenerated(
			{
				protocol: 1,
				version: "0.0.1",
				bytes: 3,
				dexSha256: "d",
				sourceSha256: "s",
				minApi: 26,
				d8: "x",
				javac: "y",
				androidJar: "z",
				builtAt: "now",
			},
			new Uint8Array([1, 2, 3])
		);
		expect(text).toContain("export const UIAD_DEX = {");
		expect(text).toContain('base64: "AQID"');
		expect(text).toContain('sourceSha256: "s"');
		expect(text.endsWith("} as const;\n")).toBe(true);
	});
});
