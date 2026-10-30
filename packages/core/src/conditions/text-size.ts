import { err, ok, type Result } from "@delacour/warden-types/result";
import { TEXT_SIZE_NAMES, type TextSize } from "./conditions.types";

/** Approximate font scale of each iOS content size category (UIFontMetrics body text; 1 = `large`, the default). */
export const TEXT_SIZE_SCALE: Record<(typeof TEXT_SIZE_NAMES)[number], number> = {
	"extra-small": 0.82,
	small: 0.88,
	medium: 0.94,
	large: 1,
	"extra-large": 1.12,
	"extra-extra-large": 1.24,
	"extra-extra-extra-large": 1.35,
	"accessibility-medium": 1.6,
	"accessibility-large": 1.9,
	"accessibility-extra-large": 2.35,
	"accessibility-extra-extra-large": 2.75,
	"accessibility-extra-extra-extra-large": 3.1,
};

/** The largest `font_scale` Android's own settings offer; asking for more is clamped to it. */
export const ANDROID_MAX_FONT_SCALE = 2;
export const ANDROID_MIN_FONT_SCALE = 0.5;

export type ResolvedTextSize = {
	/** iOS content size category (the nearest one for a number) */
	category: (typeof TEXT_SIZE_NAMES)[number];
	/** font scale (the category's for a name) */
	scale: number;
};

const isName = (v: string): v is (typeof TEXT_SIZE_NAMES)[number] => (TEXT_SIZE_NAMES as readonly string[]).includes(v);

/** A name or a scale as both: the category iOS needs and the scale Android needs. */
export function resolveTextSize(size: TextSize): Result<ResolvedTextSize> {
	if (typeof size === "number") {
		if (!Number.isFinite(size) || size <= 0) return err(`text size must be a positive scale, got ${String(size)}`);
		let best = TEXT_SIZE_NAMES[0] as (typeof TEXT_SIZE_NAMES)[number];
		for (const name of TEXT_SIZE_NAMES) {
			if (Math.abs(TEXT_SIZE_SCALE[name] - size) < Math.abs(TEXT_SIZE_SCALE[best] - size)) best = name;
		}
		return ok({ category: best, scale: size });
	}
	if (!isName(size))
		return err(`unknown text size "${String(size)}" (use ${TEXT_SIZE_NAMES.join(", ")} or a scale like 1.3)`);
	return ok({ category: size, scale: TEXT_SIZE_SCALE[size] });
}

/** Android's `font_scale` for `scale`, clamped to what the platform takes. */
export const androidFontScale = (scale: number): number =>
	Math.min(ANDROID_MAX_FONT_SCALE, Math.max(ANDROID_MIN_FONT_SCALE, Math.round(scale * 100) / 100));

/** The part of an a11y request the platform applied (a skipped setting is not on the device, so not recorded). */
export function appliedA11y<T extends object>(op: T, applied: readonly string[]): Partial<T> {
	return Object.fromEntries(Object.entries(op).filter(([key]) => applied.includes(key))) as Partial<T>;
}
