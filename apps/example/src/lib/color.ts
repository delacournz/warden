const FUNCTIONAL_COLOR = /^[a-z][a-z-]*\(/i;

/**
 * True when a string is a literal CSS colour rather than a theme token name.
 *
 * Theme tokens (`foreground`, `destructive-soft-foreground`, `emerald-500`) are
 * resolved through a CSS variable; literals are handed to the platform as-is.
 * The two are told apart by shape: a literal is either hex or a functional
 * notation, and no token name can look like either.
 */
export function isLiteralColor(value: string): boolean {
	return value.startsWith("#") || FUNCTIONAL_COLOR.test(value);
}

/** The `--color-` prefix this package used before it adopted shadcn's names. */
const LEGACY_PREFIX = "--color-";

/**
 * The CSS variable a token name resolves to.
 *
 * The raw name, not the `--color-*` one: `theme.css` maps raw onto `--color-*`
 * through `@theme inline`, and `inline` means Tailwind substitutes the value
 * into each utility and emits no `--color-*` variable at all. Only the raw
 * names exist at runtime.
 *
 * A `--color-*` argument is rewritten rather than rejected — it is what a
 * caller wrote before this package took shadcn's names, and left alone it would
 * miss silently on every render.
 *
 * Pure, and separate from `useThemeColor` so it is reachable from `bun test` —
 * the hook imports `uniwind`, which Bun's transpiler cannot parse. See AGENTS.md.
 */
export function themeVariableName(token: string): string {
	if (token.startsWith(LEGACY_PREFIX)) return `--${token.slice(LEGACY_PREFIX.length)}`;
	if (token.startsWith("--")) return token;

	return `--${token}`;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*([^,]+),\s*([^,]+),\s*([^,)]+)/i;

/**
 * The same colour at zero alpha, for the far end of a fade.
 *
 * A gradient must never fade to the keyword `transparent`: that is transparent
 * BLACK, and interpolating toward it drags every stop between through grey — a
 * dark bloom over a light ground, a milky one over a dark. The far stop has to
 * be the near colour with its alpha taken off, which is what this returns.
 *
 * `undefined` for anything it cannot take apart, which a caller should read as
 * "do not draw" rather than reaching for the keyword after all. A colour that
 * arrives here in a notation this does not know is a colour whose channels are
 * not knowable without a parser, and a fade is not worth one.
 */
export function transparentOf(color: string | undefined): string | undefined {
	if (!color) return undefined;

	if (HEX.test(color)) {
		const digits = color.slice(1);
		// A short hex cannot take a suffix: `#abc` + `00` is a four-digit hex,
		// which is `#aabbccdd` shorthand and not the colour at all.
		const rgb =
			digits.length <= 4
				? digits
						.slice(0, 3)
						.split("")
						.map((digit) => digit + digit)
						.join("")
				: digits.slice(0, 6);

		return `#${rgb}00`;
	}

	const channels = RGB.exec(color);
	if (channels) return `rgba(${channels[1]?.trim()}, ${channels[2]?.trim()}, ${channels[3]?.trim()}, 0)`;

	return undefined;
}
