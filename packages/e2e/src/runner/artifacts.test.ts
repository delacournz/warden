import { describe, expect, test } from "bun:test";
import { attemptDir, flowIdOf, hash6, screenshotPath, slug } from "./artifacts";

describe("slug", () => {
	test("lowercases and collapses punctuation", () => {
		expect(slug("Onboarding steps -> through to Sign-In!")).toBe("onboarding-steps-through-to-sign-in");
	});
	test("strips accents", () => {
		expect(slug("Café déjà vu")).toBe("cafe-deja-vu");
	});
	test("caps length without a trailing dash", () => {
		const s = slug(`${"a".repeat(59)} b${"c".repeat(20)}`);
		expect(s.length).toBeLessThanOrEqual(60);
		expect(s.endsWith("-")).toBe(false);
	});
	test("falls back when nothing is left", () => {
		expect(slug("!!!")).toBe("test");
		expect(slug("日本語", "x")).toBe("x");
	});
});

describe("hash6", () => {
	test("is 6 hex chars, stable, input-sensitive", () => {
		expect(hash6("a", "b")).toMatch(/^[0-9a-f]{6}$/);
		expect(hash6("a", "b")).toBe(hash6("a", "b"));
		expect(hash6("a", "b")).not.toBe(hash6("ab"));
	});
});

describe("attemptDir", () => {
	test("<out>/<flowId>/<title-slug>-<hash6>", () => {
		expect(attemptDir("/out", "auth/sign-in", ["Sign in", "shows an error"], "abcdef123456")).toBe(
			"/out/auth/sign-in/sign-in-shows-an-error-abcdef"
		);
	});
});

describe("screenshotPath", () => {
	test("zero-pads and slugs", () => {
		expect(screenshotPath("/d", 1, "After Login")).toBe("/d/screenshots/001-after-login.png");
		expect(screenshotPath("/d", 42, "")).toBe("/d/screenshots/042-screenshot.png");
	});
});

describe("flowIdOf", () => {
	test("relative to the flows dir, no extension", () => {
		expect(flowIdOf("/app/e2e/sign-in.e2e.ts", "/app/e2e")).toBe("sign-in");
		expect(flowIdOf("/app/e2e/auth/Log In.e2e.ts", "/app/e2e")).toBe("auth/log-in");
	});
	test("basename when outside or without a flows dir", () => {
		expect(flowIdOf("/other/x.e2e.ts", "/app/e2e")).toBe("x");
		expect(flowIdOf("/other/Some_Flow.test.ts")).toBe("some-flow-test");
	});
});
