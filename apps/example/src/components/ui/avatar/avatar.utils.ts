/**
 * The avatar's pure decisions — initials, image retry, group overflow and the
 * name a screen reader reads.
 *
 * Free of React Native imports so `bun test` reaches every one of them. The
 * source type is restated structurally rather than imported as
 * `ImageSourcePropType` for the same reason. See AGENTS.md.
 */

/** One entry of an image source, as `Image` accepts it — a URI request or a bundled asset's module id. */
export type AvatarSourceEntry = number | { uri?: string; headers?: Record<string, string> };

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
 * last. `Mary Jane Watson` reads `MW`, which is how a person signs rather than
 * how a form abbreviates them. A single word gives a single letter.
 *
 * Walks code points rather than UTF-16 units, so a letter outside the basic
 * plane is kept whole instead of drawn as a replacement box, and skips leading
 * punctuation so a quoted nickname still gives a letter.
 */
export function resolveAvatarInitials(name: string | undefined): string {
	const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "";
	const first = initialOf(words[0] ?? "");
	const last = words.length > 1 ? initialOf(words[words.length - 1] ?? "") : "";
	return `${first}${last}`.toUpperCase();
}

function entryKey(entry: AvatarSourceEntry): string | null {
	if (typeof entry === "number") return `asset:${entry}`;
	if (!entry.uri) return null;
	if (!entry.headers) return `uri:${entry.uri}`;
	const headers = Object.keys(entry.headers)
		.sort()
		.map((name) => `${name}=${entry.headers?.[name]}`)
		.join("&");
	return `uri:${entry.uri}#${headers}`;
}

/**
 * A string that changes exactly when the image request changes.
 *
 * The avatar remembers which source failed by this key rather than by object
 * identity, because an inline `source={{ uri }}` is a new object every render —
 * keyed by identity, a failed image would retry forever. Keyed by URI alone, a
 * token refresh in the headers would never retry at all. Header order is
 * normalised so an equal request is an equal key.
 *
 * `null` means there is nothing to load.
 */
export function resolveAvatarSourceKey(source: AvatarSource | null | undefined): string | null {
	if (source === null || source === undefined) return null;
	const entries: readonly AvatarSourceEntry[] = Array.isArray(source) ? source : [source as AvatarSourceEntry];
	const keys = entries.map(entryKey).filter((key): key is string => key !== null);
	return keys.length === 0 ? null : keys.join("|");
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

/**
 * The name a screen reader gives the avatar: an explicit label, else the
 * person's name, else the fallback text. Blank strings count as absent, so an
 * avatar with nothing to say is not announced as an empty image.
 */
export function resolveAvatarAccessibilityLabel({
	accessibilityLabel,
	name,
	fallback,
}: {
	accessibilityLabel?: string;
	name?: string;
	fallback?: string;
}): string | undefined {
	for (const candidate of [accessibilityLabel, name, fallback]) {
		const trimmed = candidate?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}
