import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FAKE_HELPER_MANIFEST = {
	version: "0.1.0",
	idb: "1.1.8",
	xcode: "26.6 (17F113)",
	builtAt: "2026-10-16T00:00:00Z",
};

/** A tree shaped like `packages/e2e/native/dist` (what `native:build` stages), with placeholder contents. */
export function fakeHelperDist(
	dir: string,
	opts: { frameworks?: string[]; guest?: boolean; manifest?: boolean; binary?: boolean } = {}
): void {
	const { frameworks = ["CoreSimulatorStub.framework", "AccessibilityPlatformTranslationStub.framework"] } = opts;
	mkdirSync(dir, { recursive: true });
	if (opts.binary !== false)
		writeFileSync(join(dir, "warden-simd"), "#!/bin/sh\necho warden-simd 0.1.0\n", { mode: 0o755 });
	if (opts.guest !== false) {
		mkdirSync(join(dir, "Resources"), { recursive: true });
		writeFileSync(join(dir, "Resources", "SimulatorFrameworkBridge-iOS"), "guest");
	}
	for (const framework of frameworks) {
		mkdirSync(join(dir, framework), { recursive: true });
		writeFileSync(join(dir, framework, "Info.plist"), "plist");
	}
	if (opts.manifest !== false) writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(FAKE_HELPER_MANIFEST)}\n`);
}
