import type { CommandContext } from "../context";
import { warn } from "../output";
import { SLUG_TAKEN, type WardenApi } from "./api";
import type { Organization } from "./api.types";
import {
	fallbackSlug,
	isValidOrgSlug,
	normalizeSlugInput,
	slugBase,
	validateOrgName,
	validateOrgSlug,
} from "./org-slug";

export type CreateOrgOptions = {
	/** skip the name prompt */
	name?: string;
	/** use this slug as is (no prompt); taken or invalid fails */
	slug?: string;
	/** the 6 hex suffix bytes of a fallback slug (tests) */
	random?: () => Uint8Array;
};

export type CreateOrgResult =
	| { kind: "created"; organization: Organization }
	| { kind: "cancelled" }
	| { kind: "failed"; message: string };

/** Re-asks for a slug after this many taken ones. */
const MAX_SLUG_TRIES = 5;

/** `taken` only when warden-api says so; a failed check is treated as free (create refuses a taken slug anyway). */
async function isTaken(api: WardenApi, slug: string): Promise<boolean> {
	const checked = await api.checkOrganizationSlug(slug);
	return checked.success && checked.data === "taken";
}

/** The slug the dashboard would suggest: the name's own slug while it is valid and free, else it plus 6 hex. */
async function suggestSlug(api: WardenApi, name: string, opts: CreateOrgOptions): Promise<string> {
	const base = slugBase(name);
	if (isValidOrgSlug(base) && !(await isTaken(api, base))) return base;
	return fallbackSlug(name, opts.random);
}

/** One prompted or given value (a name or a slug), or why there is none. */
type Answer = { kind: "value"; value: string } | { kind: "cancelled" } | { kind: "failed"; message: string };

/** Ask for the slug, prefilled; a taken one is reported and asked again with a fresh fallback. */
async function promptSlug(
	ctx: CommandContext,
	api: WardenApi,
	name: string,
	first: string,
	opts: CreateOrgOptions
): Promise<Answer> {
	let suggestion = first;
	for (let tries = 0; tries < MAX_SLUG_TRIES; tries++) {
		const answer = await ctx.ui.text("Slug?", {
			initialValue: suggestion,
			validate: (v) => validateOrgSlug(normalizeSlugInput(v)),
		});
		if (answer === undefined) return { kind: "cancelled" };
		const slug = normalizeSlugInput(answer);
		if (slug === first || !(await isTaken(api, slug))) return { kind: "value", value: slug };
		warn(ctx, `${slug} is taken`);
		suggestion = fallbackSlug(name, opts.random);
	}
	return { kind: "failed", message: `no free slug after ${MAX_SLUG_TRIES} tries` };
}

async function pickName(ctx: CommandContext, opts: CreateOrgOptions): Promise<Answer> {
	if (opts.name !== undefined) {
		const why = validateOrgName(opts.name);
		return why ? { kind: "failed", message: `organization name: ${why}` } : { kind: "value", value: opts.name.trim() };
	}
	if (!ctx.ui.interactive) return { kind: "failed", message: "pass a name: warden org create <name>" };
	const answer = await ctx.ui.text("Organization name?", { placeholder: "Acme Mobile", validate: validateOrgName });
	return answer === undefined ? { kind: "cancelled" } : { kind: "value", value: answer.trim() };
}

async function pickSlug(ctx: CommandContext, api: WardenApi, name: string, opts: CreateOrgOptions): Promise<Answer> {
	if (opts.slug !== undefined) {
		const slug = normalizeSlugInput(opts.slug);
		const why = validateOrgSlug(slug);
		if (why) return { kind: "failed", message: `slug ${slug}: ${why}` };
		return (await isTaken(api, slug))
			? { kind: "failed", message: `${slug} is taken` }
			: { kind: "value", value: slug };
	}
	const suggestion = await suggestSlug(api, name, opts);
	return ctx.ui.interactive ? promptSlug(ctx, api, name, suggestion, opts) : { kind: "value", value: suggestion };
}

/**
 * Create an organization the way warden-web's first-run form does: a name (asked at a terminal when not given),
 * a slug prefilled from it and checked for availability, then `organization/create`, which makes it the
 * session's active org.
 */
export async function createOrganization(
	ctx: CommandContext,
	api: WardenApi,
	opts: CreateOrgOptions = {}
): Promise<CreateOrgResult> {
	const name = await pickName(ctx, opts);
	if (name.kind !== "value") return name;
	const slug = await pickSlug(ctx, api, name.value, opts);
	if (slug.kind !== "value") return slug;
	const created = await api.createOrganization({ name: name.value, slug: slug.value });
	if (created.success) return { kind: "created", organization: created.data };
	const taken = "code" in created.error && created.error.code === SLUG_TAKEN;
	return { kind: "failed", message: taken ? `${slug.value} was just taken; try again` : created.error.message };
}
