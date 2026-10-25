export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

/** What the reader chose; anything unrecognised (or nothing stored) follows the OS. */
export function parsePreference(raw: string | null): ThemePreference {
	return raw === "light" || raw === "dark" ? raw : "system";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
	if (preference === "system") return systemDark ? "dark" : "light";
	return preference;
}

/**
 * Runs inline in `<head>`, before `<body>` exists, so the first paint already
 * has `.dark` on `<html>`. The server cannot know the reader's OS setting or
 * stored choice, so the markup it sends carries no theme class; set any later
 * than this and a slow or streamed response paints the light ground first.
 * Self-contained on purpose: it is serialised into the document, not bundled.
 */
export const themeScript = `(function(){var t=null;try{t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}var d=t==="dark"||(t!=="light"&&matchMedia(${JSON.stringify(SYSTEM_DARK_QUERY)}).matches);document.documentElement.classList.toggle("dark",d)})()`;

/**
 * The `<head>` script tag for `themeScript`. The site is proxied by Cloudflare,
 * and Rocket Loader rewrites every `<script>` so the browser skips it and its own
 * deferred loader replays it later; for this script "later" is after the light
 * ground has painted, which is exactly the flash it exists to prevent.
 * `data-cfasync="false"` makes Rocket Loader leave the tag alone.
 */
export const themeHeadScript = { children: themeScript, "data-cfasync": "false" } as const;
