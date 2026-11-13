import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitIos, makeRepo, type PodsHarness, podsHarness } from "./pods.testing";
import type { PodsMode } from "./pods.types";
import { computePodsKey, type PodsKeyInput } from "./pods-key";

let h: PodsHarness;
let cng: string;
let bare: string;
beforeEach(async () => {
	h = podsHarness();
	cng = await makeRepo(h.dir, "cng", { ignoreIos: true });
	bare = await makeRepo(h.dir, "bare", { ignoreIos: false });
	await commitIos(bare);
});
afterEach(() => {
	h.store.close();
	rmSync(h.dir, { recursive: true, force: true });
});

function input(root: string, mode: PodsMode, over: Partial<PodsKeyInput> = {}): PodsKeyInput {
	return {
		projectRoot: root,
		root: { real: root, raw: root },
		iosDir: "ios",
		mode,
		podVersion: "1.16.2",
		planEnv: {},
		...over,
	};
}

async function keyOf(i: PodsKeyInput, env: Record<string, string> = {}): Promise<string> {
	const res = await computePodsKey({ exec: h.tc.exec, env }, i);
	if (!res.success) throw new Error(res.error);
	return res.data.key;
}

describe("computePodsKey", () => {
	test("stable across calls", async () => {
		expect(await keyOf(input(cng, "cng"))).toBe(await keyOf(input(cng, "cng")));
		expect(await keyOf(input(bare, "committed"))).toBe(await keyOf(input(bare, "committed")));
	});

	test("changes with each input", async () => {
		const base = await keyOf(input(cng, "cng"));
		const changed: Record<string, () => Promise<string>> = {
			"pod version": () => keyOf(input(cng, "cng", { podVersion: "1.17.0" })),
			fingerprint: async () => {
				h.tc.fingerprint = "fp-2";
				return keyOf(input(cng, "cng"));
			},
			arch: async () => {
				h.tc.arch = "x86_64";
				return keyOf(input(cng, "cng"));
			},
			mode: () => keyOf(input(cng, "committed")),
			"ios dir": () => keyOf(input(cng, "cng", { iosDir: "native/ios" })),
			"prebuilt salt": () => keyOf(input(cng, "cng", { planSalt: "react-native:prebuilt" })),
			"RCT env": () => keyOf(input(cng, "cng"), { RCT_NEW_ARCH_ENABLED: "0" }),
			"USE_FRAMEWORKS env": () => keyOf(input(cng, "cng"), { USE_FRAMEWORKS: "static" }),
			"plan env": () => keyOf(input(cng, "cng", { planEnv: { RCT_USE_PREBUILT_RNCORE: "1" } })),
		};
		for (const [name, make] of Object.entries(changed)) {
			expect(await make(), name).not.toBe(base);
			h.tc.fingerprint = "fp-1";
			h.tc.arch = "arm64";
		}
	});

	test("an unrelated env var does not change it", async () => {
		expect(await keyOf(input(cng, "cng"), { HOME: "/x", FOO: "1" })).toBe(await keyOf(input(cng, "cng")));
	});

	test("project location is an input", async () => {
		const a = await keyOf({ ...input(bare, "committed"), root: { real: bare, raw: bare } });
		const b = await keyOf({ ...input(bare, "committed"), root: { real: join(bare, ".."), raw: join(bare, "..") } });
		expect(a).not.toBe(b);
	});

	test("cng ignores the prebuilt project.pbxproj and the rest of ios/", async () => {
		const before = await keyOf(input(cng, "cng"));
		await Bun.$`mkdir -p ${cng}/ios/App.xcodeproj`;
		writeFileSync(join(cng, "ios/App.xcodeproj/project.pbxproj"), "random ids 1");
		writeFileSync(join(cng, "ios/Podfile"), "different");
		expect(await keyOf(input(cng, "cng"))).toBe(before);
	});

	test("committed: Podfile, properties and tracked files are inputs; pod install's own writes are not", async () => {
		const base = await keyOf(input(bare, "committed"));
		writeFileSync(join(bare, "ios/App.xcodeproj/project.pbxproj"), "// integrated by pod install\n");
		writeFileSync(join(bare, "ios/App/Info.plist"), "<plist>aggregated</plist>\n");
		writeFileSync(join(bare, "ios/Podfile.lock"), "lock");
		await Bun.$`mkdir -p ${bare}/ios/Pods && echo x > ${bare}/ios/Pods/y`.quiet();
		expect(await keyOf(input(bare, "committed"))).toBe(base);

		writeFileSync(join(bare, "ios/Podfile"), "target 'App' do\n  # edit\nend\n");
		const podfile = await keyOf(input(bare, "committed"));
		expect(podfile).not.toBe(base);
		writeFileSync(join(bare, "ios/Podfile.properties.json"), "{}");
		const props = await keyOf(input(bare, "committed"));
		expect(props).not.toBe(podfile);
		writeFileSync(join(bare, "ios/AppDelegate.swift"), "x");
		await Bun.$`git -C ${bare} add ios/AppDelegate.swift`.quiet();
		const tracked = await keyOf(input(bare, "committed"));
		expect(tracked).not.toBe(props);
		writeFileSync(join(bare, "ios/AppDelegate.swift"), "edited, uncommitted");
		expect(await keyOf(input(bare, "committed"))).not.toBe(tracked);
	});

	test("an unreadable fingerprint is an error, not a key", async () => {
		h.tc.fingerprint = "";
		const res = await computePodsKey(
			{
				exec: async (c, o) =>
					c.some((x) => x.includes("fingerprint")) ? { exitCode: 1, stdout: "", stderr: "boom" } : h.tc.exec(c, o),
				env: {},
			},
			input(cng, "cng")
		);
		expect(res.success).toBe(false);
	});
});
