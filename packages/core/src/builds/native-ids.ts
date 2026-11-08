import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "../types";

/** How an app is run: Expo (`expo start`, a dev client) or bare React Native (`react-native start`, the app itself). */
export type AppFramework = "expo" | "react-native";

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * The app's framework from its `package.json`: `expo` when it depends on `expo`, `react-native` when
 * only on `react-native`; undefined without either (or without a readable `package.json`).
 */
export function appFramework(root: string): AppFramework | undefined {
	const text = readText(join(root, "package.json"));
	if (text === undefined) return undefined;
	let manifest: unknown;
	try {
		manifest = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(manifest)) return undefined;
	const deps = [manifest.dependencies, manifest.devDependencies].filter(isRecord);
	if (deps.some((d) => "expo" in d)) return "expo";
	if (deps.some((d) => "react-native" in d)) return "react-native";
	return undefined;
}

/** Xcode's `rfc1034identifier`: anything but letters, digits, `-` and `.` becomes `-`. */
function rfc1034(name: string): string {
	return name.replace(/[^A-Za-z0-9.-]/g, "-");
}

/** The app target's `PRODUCT_BUNDLE_IDENTIFIER` in `ios/*.xcodeproj` (test targets and Pods skipped). */
function iosBundleId(root: string, appName: string): string | undefined {
	const ios = join(root, "ios");
	let entries: string[];
	try {
		entries = readdirSync(ios).filter((e) => e.endsWith(".xcodeproj") && e !== "Pods.xcodeproj");
	} catch {
		return undefined;
	}
	for (const project of entries.sort()) {
		const text = readText(join(ios, project, "project.pbxproj"));
		if (text === undefined) continue;
		for (const match of text.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g)) {
			const raw = match[1]?.trim();
			if (raw === undefined || /Tests?$/.test(raw)) continue;
			const id = raw.replace("$(PRODUCT_NAME:rfc1034identifier)", rfc1034(appName)).replace("$(PRODUCT_NAME)", appName);
			if (!id.includes("$(")) return id;
		}
	}
	return undefined;
}

/** `applicationId` in `android/app/build.gradle(.kts)`. */
function androidPackage(root: string): string | undefined {
	for (const file of ["build.gradle", "build.gradle.kts"]) {
		const text = readText(join(root, "android", "app", file));
		const id = text?.match(/applicationId\s*=?\s*["']([^"']+)["']/)?.[1];
		if (id !== undefined) return id;
	}
	return undefined;
}

/**
 * A bare React Native app's ids, read from its native projects: iOS `PRODUCT_BUNDLE_IDENTIFIER`
 * (the template's `$(PRODUCT_NAME:rfc1034identifier)` filled in with `appName`), Android
 * `applicationId`. A platform whose id can't be read (no native dir, a build variable) is left out.
 */
export function nativeBundleIds(root: string, appName: string): Partial<Record<Platform, string>> {
	const ios = existsSync(join(root, "ios")) ? iosBundleId(root, appName) : undefined;
	const android = androidPackage(root);
	return { ...(ios ? { ios } : {}), ...(android ? { android } : {}) };
}
