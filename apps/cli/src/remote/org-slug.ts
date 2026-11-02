/**
 * Organization name + slug rules, mirroring warden-web's create form (`apps/web/src/lib/paths.ts`) so the CLI
 * suggests the same slug the dashboard would. warden-api is the authority (`INVALID_SLUG`, `INVALID_NAME`,
 * `ORGANIZATION_SLUG_ALREADY_TAKEN`).
 */

export const ORG_NAME_MAX = 80;
const ORG_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The name in lower-case dashes (≤ 40), or "" when nothing slug-shaped is left. */
export function slugBase(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
}

/** 3–48 chars of lower-case letters and digits in single-dash runs. */
export function isValidOrgSlug(slug: string): boolean {
	return slug.length >= 3 && slug.length <= 48 && ORG_SLUG.test(slug);
}

/** The slug when the name's own one is taken or too short: base (or `org`) plus 6 hex chars. */
export function fallbackSlug(
	name: string,
	random: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(3))
): string {
	const suffix = Array.from(random(), (b) => b.toString(16).padStart(2, "0")).join("");
	return `${slugBase(name) || "org"}-${suffix}`;
}

/** What someone typed, made slug-shaped where unambiguous; the rest is left for `isValidOrgSlug`. */
export function normalizeSlugInput(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-");
}

/** Why `name` can't be an organization name, or undefined. */
export function validateOrgName(name: string): string | undefined {
	const trimmed = name.trim();
	if (trimmed.length === 0) return "enter a name";
	if (trimmed.length > ORG_NAME_MAX) return `at most ${ORG_NAME_MAX} characters`;
	return undefined;
}

/** Why `slug` can't be a slug, or undefined. */
export function validateOrgSlug(slug: string): string | undefined {
	return isValidOrgSlug(slug) ? undefined : "3–48 lower-case letters, digits and single dashes (acme-mobile)";
}
