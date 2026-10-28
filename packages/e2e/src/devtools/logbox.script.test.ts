import { describe, expect, test } from "bun:test";
import { LOGBOX_SCRIPT } from "./logbox.script";

type LogBoxData = {
	patterns: RegExp[];
	disabled: boolean;
	selected: number;
	addIgnorePatterns: (patterns: RegExp[]) => void;
	setDisabled: (value: boolean) => void;
	setSelectedLog: (index: number) => void;
};

function logBoxData(): LogBoxData {
	const data: LogBoxData = {
		patterns: [],
		disabled: false,
		selected: 0,
		addIgnorePatterns: (patterns) => data.patterns.push(...patterns),
		setDisabled: (value) => {
			data.disabled = value;
		},
		setSelectedLog: (index) => {
			data.selected = index;
		},
	};
	return data;
}

type Module = { verboseName?: string; isInitialized: boolean; publicModule: { exports: unknown } };

function pageWith(modules: Module[]): Record<string, unknown> {
	const map = new Map(modules.map((mod, id) => [id, mod]));
	const require = Object.assign(() => undefined, { getModules: () => map });
	return { __r: require };
}

const mod = (verboseName: string, exports: unknown, isInitialized = true): Module => ({
	verboseName,
	isInitialized,
	publicModule: { exports },
});

function run(g: Record<string, unknown>): string {
	const fn: (g: Record<string, unknown>) => string = new Function(`return (${LOGBOX_SCRIPT});`)();
	return fn(g);
}

describe("LOGBOX_SCRIPT", () => {
	test("no Metro require (release build, bundle not loaded yet) is no-require", () => {
		expect(run({})).toBe("no-require");
		expect(run({ __r: () => undefined })).toBe("no-require");
	});

	test("LogBoxData not defined or not initialized yet is not-ready", () => {
		expect(run(pageWith([mod("src/app.tsx", {})]))).toBe("not-ready");
		const data = logBoxData();
		expect(run(pageWith([mod("node_modules/react-native/Libraries/LogBox/Data/LogBoxData.js", data, false)]))).toBe(
			"not-ready"
		);
	});

	test("ignores every log, disables notifications and closes an open inspector", () => {
		const data = logBoxData();
		const g = pageWith([
			mod("src/app.tsx", {}),
			mod("../../node_modules/react-native/Libraries/LogBox/Data/LogBoxData.js", data),
		]);
		expect(run(g)).toBe("off");
		expect(data.disabled).toBe(true);
		expect(data.selected).toBe(-1);
		expect(data.patterns).toHaveLength(1);
		const [all] = data.patterns;
		expect(all?.test("[AuthClient] Email code request failed")).toBe(true);
		expect(all?.test("multi\nline")).toBe(true);
		expect(all?.test("")).toBe(true);
	});

	test("matches a Windows module path", () => {
		const data = logBoxData();
		const g = pageWith([mod("node_modules\\react-native\\Libraries\\LogBox\\Data\\LogBoxData.js", data)]);
		expect(run(g)).toBe("off");
		expect(data.disabled).toBe(true);
	});
});
