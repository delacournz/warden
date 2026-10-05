/**
 * Names of the semantic size tokens defined in `tokens.css`.
 *
 * These exist so `cn()` can teach tailwind-merge about them. Without that,
 * `h-button-md` is an unrecognised utility and twMerge will not drop it when a
 * caller passes `h-12` — both survive and the override silently stops working.
 * {@link ../lib/cn} registers every name here, and a test asserts this list
 * still matches `tokens.css`.
 *
 * Values live in the CSS, not here. A component references a token by writing
 * the class out in full (`size-icon-md`) — Tailwind scans source text, so a
 * name assembled at runtime would never be compiled.
 */

/** Suffixes in the `--spacing-*` namespace: `h-button-md`, `w-button-md`. */
export const BUTTON_SIZE_TOKENS = ["button-sm", "button-md", "button-lg"] as const;

/** Suffixes in the `--spacing-*` namespace: `size-icon-md`. */
export const ICON_SIZE_TOKENS = ["icon-xs", "icon-sm", "icon-md", "icon-lg", "icon-xl", "icon-2xl"] as const;

/**
 * Suffixes in the `--spacing-*` namespace: `h-navbar-row`, `px-screen-gutter`.
 *
 * Not a scale — two independent measurements of a screen's chrome — so unlike
 * the icon and button tokens their order carries no meaning.
 */
export const SCREEN_SIZE_TOKENS = ["navbar-row", "screen-gutter"] as const;

/**
 * Suffixes in the `--spacing-*` namespace: `h-input-md`, `min-h-input-md`.
 *
 * Read on two axes, unlike the button's: a single-line field takes the height
 * as a fixed one and a multiline field takes it as a floor, so both `h-` and
 * `min-h-` have to be recognised.
 */
export const INPUT_SIZE_TOKENS = ["input-sm", "input-md", "input-lg"] as const;

/**
 * Suffixes in the `--radius-*` namespace: `rounded-button-md`.
 *
 * Stepped with the button's heights rather than borrowing the generic
 * `--radius-*` scale, so the corner is retuned with the control it belongs to
 * and a caller's `rounded-lg` still overrides it.
 */
export const BUTTON_RADIUS_TOKENS = ["button-sm", "button-md", "button-lg"] as const;

/** Suffixes in the `--text-*` namespace: `text-button-md`. */
export const BUTTON_TEXT_TOKENS = ["button-sm", "button-md", "button-lg"] as const;

/** Suffixes in the `--text-*` namespace: `text-input-md`. */
export const INPUT_TEXT_TOKENS = ["input-sm", "input-md", "input-lg"] as const;

/**
 * Suffixes in the `--spacing-*` namespace: `h-chart-md`.
 *
 * A chart canvas has no intrinsic height, so one is named here rather than
 * written as a `h-56` at each call site — a dashboard's rows only line up if
 * every chart agrees, and they only stay agreed if there is one number.
 */
export const CHART_SIZE_TOKENS = ["chart-sm", "chart-md", "chart-lg"] as const;

/**
 * The tailwind-merge extension both mergers in this package are built from.
 *
 * There are two, and they are easy to forget: `cn()` merges a caller's
 * className, and `tv()` merges slots and variants using a tailwind-merge
 * instance of its own. Extending only one leaves the other treating
 * `text-button-md` as an unrecognised utility — which is how a size token ends
 * up colliding with a colour and silently dropping it. One config, read by
 * `lib/cn.ts` and `lib/tv.ts`, so they cannot drift apart.
 *
 * `border-curve` is Uniwind's, not Tailwind's: `border-continuous` sets iOS's
 * `borderCurve`. Unregistered, tailwind-merge reads it as a border *colour*,
 * and `border-continuous border-border` loses one of the two.
 */
export const TW_MERGE_CONFIG = {
	extend: {
		classGroups: {
			"border-curve": ["border-continuous", "border-circular"],
		},
		theme: {
			radius: [...BUTTON_RADIUS_TOKENS],
			spacing: [
				...BUTTON_SIZE_TOKENS,
				...CHART_SIZE_TOKENS,
				...ICON_SIZE_TOKENS,
				...INPUT_SIZE_TOKENS,
				...SCREEN_SIZE_TOKENS,
			],
			text: [...BUTTON_TEXT_TOKENS, ...INPUT_TEXT_TOKENS],
		},
	},
} as const;

/** Class groups `TW_MERGE_CONFIG` adds, which tailwind-merge's extension has to be told about by name. */
export type CustomClassGroupId = keyof typeof TW_MERGE_CONFIG.extend.classGroups;
