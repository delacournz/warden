import { useMemo } from "react";
import { useCSSVariable } from "uniwind";
import { isLiteralColor, themeVariableName } from "@/lib/color";

/** Defined by every theme, so looking it up never misses and never warns. */
const PROBE_VARIABLE = "--foreground";

/**
 * Reads a theme colour as a plain string for props that take a colour value
 * rather than a style — icon `color`, gradient stops, chart series, and any
 * third-party component that will not accept a className.
 *
 * Resolves against the nearest `ScopedTheme`, so it follows light/dark and any
 * custom theme automatically. Prefer a `bg-*`/`text-*` className wherever the
 * target actually accepts one.
 *
 * A literal colour — `#EC4899`, `rgb(...)` — passes straight through without
 * being looked up, so a caller can hand one to any prop typed as a token
 * without special-casing it.
 *
 * A token resolves only if the active theme actually emits its CSS variable.
 * That is the semantic palette in `styles/theme.css` — Tailwind's own palette
 * names (`emerald-500`) are not emitted unless some utility class references
 * them. An unresolved token yields `undefined` rather than a bogus value.
 *
 * The variable looked up is the RAW name — `--destructive`, not
 * `--color-destructive`. `theme.css` maps the raw names onto the `--color-*`
 * namespace through `@theme inline`, and `inline` means Tailwind substitutes
 * the value into each utility and emits no `--color-*` variable at all. Those
 * names do not exist at runtime; the raw ones are the only thing there. They
 * are also the names a shadcn theme is written in, so `useThemeColor("chart-1")`
 * works on a pasted palette with no support from this package.
 */
export function useThemeColor(token: string): string | undefined {
	const isLiteral = isLiteralColor(token);
	const name = themeVariableName(token);

	// A literal still has to go through the hook — hook order cannot be
	// conditional — but it must not be the thing looked up. Uniwind logs a
	// warning on every miss, and `--#EC4899` misses on every single render.
	// Probe a variable that is always defined instead, and discard it.
	const resolved = useCSSVariable(isLiteral ? PROBE_VARIABLE : name) as string | undefined;

	return isLiteral ? token : resolved;
}

/**
 * {@link useThemeColor} for several tokens in one lookup, keyed by token.
 *
 * For a renderer that cannot call a hook where it draws — a Skia canvas is a second React
 * reconciler, so a theme hook inside it reads no `ScopedTheme`. Resolve above the canvas, pass the
 * record in. Hand it a list that is equal across renders (sorted, deduplicated) and the lookup
 * does not re-subscribe.
 */
export function useThemeColors(tokens: readonly string[]): Readonly<Record<string, string | undefined>> {
	const names = tokens.map((token) => (isLiteralColor(token) ? PROBE_VARIABLE : themeVariableName(token)));
	const resolved = useCSSVariable(names.length > 0 ? names : [PROBE_VARIABLE]);
	const key = tokens.join("\n");

	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `tokens`, which a caller may rebuild every render.
	return useMemo(() => {
		const colors: Record<string, string | undefined> = {};
		tokens.forEach((token, index) => {
			const value = resolved[index];
			colors[token] = isLiteralColor(token) ? token : typeof value === "string" ? value : undefined;
		});
		return colors;
	}, [key, resolved]);
}
