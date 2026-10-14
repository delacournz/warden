import { describe, expect, test } from "bun:test";
import { parsePreference, resolveTheme, THEME_STORAGE_KEY, themeScript } from "./theme";

describe("parsePreference", () => {
	test("stored light / dark / system are kept", () => {
		expect(parsePreference("light")).toBe("light");
		expect(parsePreference("dark")).toBe("dark");
		expect(parsePreference("system")).toBe("system");
	});

	test("nothing stored, or junk, follows the system", () => {
		expect(parsePreference(null)).toBe("system");
		expect(parsePreference("sepia")).toBe("system");
	});
});

describe("resolveTheme", () => {
	test("an explicit choice beats the OS", () => {
		expect(resolveTheme("light", true)).toBe("light");
		expect(resolveTheme("dark", false)).toBe("dark");
	});

	test("system follows the OS", () => {
		expect(resolveTheme("system", true)).toBe("dark");
		expect(resolveTheme("system", false)).toBe("light");
	});
});

/** Runs the inline head script against stubbed browser globals; returns whether `dark` ended up on <html>. */
function runScript(stored: string | null | "throws", systemDark: boolean): boolean {
	const classes = new Set<string>();
	const document = {
		documentElement: {
			classList: {
				toggle: (name: string, on: boolean) => {
					if (on) classes.add(name);
					else classes.delete(name);
				},
			},
		},
	};
	const localStorage = {
		getItem: (key: string) => {
			if (stored === "throws") throw new Error("storage blocked");
			return key === THEME_STORAGE_KEY ? stored : null;
		},
	};
	const matchMedia = () => ({ matches: systemDark });
	new Function("document", "localStorage", "matchMedia", themeScript)(document, localStorage, matchMedia);
	return classes.has("dark");
}

describe("themeScript", () => {
	test("no stored choice follows the OS", () => {
		expect(runScript(null, true)).toBe(true);
		expect(runScript(null, false)).toBe(false);
	});

	test("a stored choice beats the OS", () => {
		expect(runScript("light", true)).toBe(false);
		expect(runScript("dark", false)).toBe(true);
		expect(runScript("system", true)).toBe(true);
	});

	test("blocked storage still follows the OS", () => {
		expect(runScript("throws", true)).toBe(true);
	});
});
