import { useSyncExternalStore } from "react";
import {
	parsePreference,
	type ResolvedTheme,
	resolveTheme,
	SYSTEM_DARK_QUERY,
	THEME_STORAGE_KEY,
	type ThemePreference,
} from "./theme";

const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
	try {
		return parsePreference(localStorage.getItem(THEME_STORAGE_KEY));
	} catch {
		return "system";
	}
}

function currentTheme(): ResolvedTheme {
	return resolveTheme(readPreference(), matchMedia(SYSTEM_DARK_QUERY).matches);
}

/** Re-derives the theme, puts it on `<html>` and tells subscribers. */
function sync(): void {
	document.documentElement.classList.toggle("dark", currentTheme() === "dark");
	for (const listener of listeners) listener();
}

/** The first subscriber starts following OS changes and other tabs; the last one stops. */
function subscribe(listener: () => void): () => void {
	const media = matchMedia(SYSTEM_DARK_QUERY);
	if (listeners.size === 0) {
		media.addEventListener("change", sync);
		window.addEventListener("storage", sync);
	}
	listeners.add(listener);

	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			media.removeEventListener("change", sync);
			window.removeEventListener("storage", sync);
		}
	};
}

export function setTheme(preference: ThemePreference): void {
	try {
		localStorage.setItem(THEME_STORAGE_KEY, preference);
	} catch {
		// Storage blocked: the choice still applies for this page view.
	}
	sync();
}

/** The theme on screen; `null` on the server and during hydration, where it is unknowable. */
export function useResolvedTheme(): ResolvedTheme | null {
	return useSyncExternalStore(subscribe, currentTheme, () => null);
}
