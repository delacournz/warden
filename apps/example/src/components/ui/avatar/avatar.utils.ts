/**
 * The avatar's pure decisions — initials, image retry, group overflow and the
 * name a screen reader reads.
 *
 * Free of React Native imports so every one of them is unit-testable. The
 * source type is restated structurally rather than imported as
 * `ImageSourcePropType` for the same reason. See AGENTS.md.
 */

import { Children, cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";

/** The cache modes `Image` accepts for a URI request. */
export type AvatarSourceCache = "default" | "reload" | "force-cache" | "only-if-cached";

/**
 * A URI request, as `Image` accepts it. Holds the fields that change what is
 * fetched, and `width`, `height` and `scale`, which pick the entry of a
 * multi-resolution list that is fetched.
 */
export type AvatarSourceRequest = {
	uri?: string | null;
	bundle?: string | null;
	method?: string | null;
	headers?: Readonly<Record<string, string>> | null;
	body?: string | null;
	cache?: AvatarSourceCache | null;
	width?: number | null;
	height?: number | null;
	scale?: number | null;
};

/** One entry of an image source, as `Image` accepts it — a URI request or a bundled asset's module id. */
export type AvatarSourceEntry = number | AvatarSourceRequest;

/** Anything `Image`'s `source` accepts: one entry or a list of resolutions. */
export type AvatarSource = AvatarSourceEntry | readonly AvatarSourceEntry[];

/** A letter or number in any script, which is what an initial has to start with. */
const INITIAL = /[\p{L}\p{N}]/u;

/** The first letter or number of a word, whole — never half a surrogate pair. */
function initialOf(word: string): string {
	return Array.from(word).find((char) => INITIAL.test(char)) ?? "";
}

/**
 * Up to two initials from a name: the first letter of the first word and of the
 * last. `Anahera Rose Tui` reads `AT`, which is how a person signs rather than
 * how a form abbreviates them. A single word gives a single letter.
 *
 * Walks code points rather than UTF-16 units, so a letter outside the basic
 * plane is kept whole instead of drawn as a replacement box, and skips leading
 * punctuation so a quoted nickname still gives a letter. The name is put in
 * NFC form first: in NFD form, as servers and macOS input often send it,
 * `É` is `E` plus a combining accent, and only the `E` would be kept.
 */
export function resolveAvatarInitials(name: string | undefined): string {
	const words = (name ?? "").normalize("NFC").trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "";
	const first = initialOf(words[0] ?? "");
	const last = words.length > 1 ? initialOf(words[words.length - 1] ?? "") : "";
	return `${first}${last}`.toUpperCase();
}

/** One entry as a plain value, ready for `JSON.stringify`. Header pairs are sorted by name. */
function entryKey(entry: AvatarSourceEntry): unknown {
	if (typeof entry === "number") return ["asset", entry];
	if (!entry.uri) return null;
	const headers = Object.entries(entry.headers ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return [
		"uri",
		entry.uri,
		entry.bundle ?? null,
		entry.method ?? null,
		headers,
		entry.body ?? null,
		entry.cache ?? null,
		entry.width ?? null,
		entry.height ?? null,
		entry.scale ?? null,
	];
}

/**
 * A string that changes exactly when the image request changes.
 *
 * The avatar remembers which source failed by this key rather than by object
 * identity, because an inline `source={{ uri }}` is a new object every render —
 * keyed by identity, a failed image would retry forever. Keyed by URI alone, a
 * token refresh in the headers would never retry at all. Every field that
 * changes the request is part of the key, including `cache`, so a cache miss
 * retries when the cache mode changes. So are `width`, `height` and `scale`:
 * with the same URIs, new dimensions can pick another entry of a list. The key is a JSON array, so no value can
 * look like a separator, and header order is normalised so an equal request is
 * an equal key.
 *
 * `null` means there is nothing to load.
 */
export function resolveAvatarSourceKey(
	source: AvatarSource | null | undefined,
	{ edge }: { edge?: number } = {}
): string | null {
	if (source === null || source === undefined) return null;
	const entries: readonly AvatarSourceEntry[] = Array.isArray(source) ? source : [source as AvatarSourceEntry];
	const keys = entries.map(entryKey).filter((key) => key !== null);
	if (keys.length === 0) return null;
	return JSON.stringify(keys.length > 1 && edge !== undefined ? [...keys, ["edge", edge]] : keys);
}

/**
 * Whether the image layer is mounted.
 *
 * The fallback is always underneath, so this is only ever a question of whether
 * the image goes on top. A failure is remembered for the key that failed, which
 * is what makes a new URI retry on its own.
 */
export function resolveAvatarShowsImage({
	sourceKey,
	failedKey,
}: {
	sourceKey: string | null;
	failedKey: string | null;
}): boolean {
	return sourceKey !== null && sourceKey !== failedKey;
}

/**
 * How many faces a group draws, and how many people the trailing tile counts.
 *
 * `max` caps the faces, not the row: five people at `max={3}` is three faces and
 * `+2`. `total` is the number of people when the children are only the first
 * few of them, so three children out of forty reads `+37`. A `total` below the
 * number of children is ignored rather than allowed to go negative, and a
 * nonsensical `max` is clamped rather than trusted.
 */
export function resolveAvatarGroup({ count, max, total }: { count: number; max?: number; total?: number }): {
	visible: number;
	overflow: number;
} {
	const cap = max === undefined || Number.isNaN(max) ? count : Math.max(0, Math.floor(max));
	const visible = Math.min(count, cap);
	const people = total !== undefined && Number.isFinite(total) ? Math.max(count, Math.floor(total)) : count;
	return { visible, overflow: people - visible };
}

/**
 * The faces a group holds, with fragments opened up.
 *
 * `Children.toArray` treats a fragment as one child, so a fragment with two
 * avatars would count as one face and skip `max`. This walks into each
 * fragment, at any depth. A face from a fragment gets the key
 * `JSON.stringify([fragmentKey, faceKey])`. A pair rather than a joined string,
 * because `.$a` + `.$b.$c` and `.$a.$b` + `.$c` join to the same text.
 */
export function flattenAvatarChildren(children: ReactNode): ReactElement[] {
	return Children.toArray(children).flatMap((child) => {
		if (!isValidElement(child)) return [];
		if (child.type !== Fragment) return [child];
		const { children: inner } = child.props as { children?: ReactNode };
		return flattenAvatarChildren(inner).map((nested) =>
			cloneElement(nested, { key: JSON.stringify([child.key, nested.key]) })
		);
	});
}

/**
 * Whether an `Avatar.Badge` has something to pin, or is a presence dot.
 *
 * Only an element counts. `{unread && <Badge />}` with `unread = 0` passes a
 * raw `0`, and a raw string or number in a `View` throws on native. So `0`,
 * `""` and other non-elements mean the dot.
 */
export function resolveAvatarBadgeHasContent(children: ReactNode): boolean {
	return Children.toArray(children).some(isValidElement);
}

/** The most the overflow tile draws before it reads `99+`. Three digits do not fit a small circle. */
export const AVATAR_OVERFLOW_DISPLAY_MAX = 99;

/**
 * What the overflow tile draws and what it reads.
 *
 * The drawn count stops at {@link AVATAR_OVERFLOW_DISPLAY_MAX}; the spoken one
 * never does, because a screen reader has room for the real number.
 */
export function resolveAvatarOverflowLabel(overflow: number): { text: string; accessibilityLabel: string } {
	return {
		text: overflow > AVATAR_OVERFLOW_DISPLAY_MAX ? `${AVATAR_OVERFLOW_DISPLAY_MAX}+` : `+${overflow}`,
		accessibilityLabel: `${overflow} more`,
	};
}

/** What a pressable avatar is called when it has no label, name or fallback. */
export const AVATAR_BUTTON_FALLBACK_LABEL = "Avatar";

/**
 * The name a screen reader gives the avatar: an explicit label, else the
 * person's name, else the fallback text. Blank strings count as absent, so an
 * avatar with nothing to say is not announced as an empty image.
 *
 * A pressable avatar always has a name. With nothing else to read it is
 * {@link AVATAR_BUTTON_FALLBACK_LABEL}, so it is never announced as only "button".
 */
export function resolveAvatarAccessibilityLabel({
	accessibilityLabel,
	name,
	fallback,
	isInteractive = false,
}: {
	accessibilityLabel?: string;
	name?: string;
	fallback?: string;
	isInteractive?: boolean;
}): string | undefined {
	for (const candidate of [accessibilityLabel, name, fallback]) {
		const trimmed = candidate?.trim();
		if (trimmed) return trimmed;
	}
	return isInteractive ? AVATAR_BUTTON_FALLBACK_LABEL : undefined;
}
