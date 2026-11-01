import { describe, expect, test } from "bun:test";
import { artifactPaths } from "./artifacts";

describe("slug", () => {
	test("lowercases and collapses punctuation", () => {
		expect(artifactPaths.slug("Onboarding steps -> through to Sign-In!")).toBe("onboarding-steps-through-to-sign-in");
	});
	test("strips accents", () => {
		expect(artifactPaths.slug("Café déjà vu")).toBe("cafe-deja-vu");
	});
	test("caps length without a trailing dash", () => {
		const s = artifactPaths.slug(`${"a".repeat(59)} b${"c".repeat(20)}`);
		expect(s.length).toBeLessThanOrEqual(60);
		expect(s.endsWith("-")).toBe(false);
	});
	test("falls back when nothing is left", () => {
		expect(artifactPaths.slug("!!!")).toBe("test");
		expect(artifactPaths.slug("日本語", "x")).toBe("x");
	});
});

describe("hash6", () => {
	test("is 6 hex chars, stable, input-sensitive", () => {
		expect(artifactPaths.hash6("a", "b")).toMatch(/^[0-9a-f]{6}$/);
		expect(artifactPaths.hash6("a", "b")).toBe(artifactPaths.hash6("a", "b"));
		expect(artifactPaths.hash6("a", "b")).not.toBe(artifactPaths.hash6("ab"));
	});
});

describe("attemptDir", () => {
	test("<out>/<specId>/<title-slug>-<hash6>", () => {
		expect(artifactPaths.attemptDir("/out", "auth/sign-in", ["Sign in", "shows an error"], "abcdef123456")).toBe(
			"/out/auth/sign-in/sign-in-shows-an-error-abcdef"
		);
	});
});

describe("screenshotPath", () => {
	test("zero-pads and slugs", () => {
		expect(artifactPaths.screenshotPath("/d", 1, "After Login")).toBe("/d/screenshots/001-after-login.png");
		expect(artifactPaths.screenshotPath("/d", 42, "")).toBe("/d/screenshots/042-screenshot.png");
	});
});

describe("specIdOf", () => {
	test("relative to the specs dir, no extension", () => {
		expect(artifactPaths.specIdOf("/app/e2e/sign-in.e2e.ts", "/app/e2e")).toBe("sign-in");
		expect(artifactPaths.specIdOf("/app/e2e/auth/Log In.e2e.ts", "/app/e2e")).toBe("auth/log-in");
	});
	test("basename when outside or without a specs dir", () => {
		expect(artifactPaths.specIdOf("/other/x.e2e.ts", "/app/e2e")).toBe("x");
		expect(artifactPaths.specIdOf("/other/Some_Spec.test.ts")).toBe("some-spec-test");
	});
});
