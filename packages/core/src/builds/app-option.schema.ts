import { z } from "zod";

/**
 * `app` on a batch preset / e2e suite: `true` installs the project's app on every device first;
 * `{ clean: true }` additionally uninstalls it first, so each run starts from a fresh container;
 * `{ variant }` installs that `projects[].variants` build instead of the project's default one.
 */
export const appOptionSchema = z.union([
	z.boolean(),
	z.object({ clean: z.boolean().optional(), variant: z.string().min(1).optional() }).strict(),
]);

export type AppOption = z.infer<typeof appOptionSchema>;

export type AppSwitches = { app: boolean; clean: boolean; variant?: string };

/** The switches `app` stands for. An object means install (`app: {}` = `app: true`). */
export function appSwitches(app: AppOption | undefined): AppSwitches {
	if (app === undefined) return { app: false, clean: false };
	if (typeof app === "boolean") return { app, clean: false };
	return { app: true, clean: app.clean === true, ...(app.variant !== undefined ? { variant: app.variant } : {}) };
}
