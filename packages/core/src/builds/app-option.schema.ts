import { z } from "zod";

/**
 * What to do with the app's installed state before a run:
 * - unset: install only when the device lacks this build; a different build is installed over the old one.
 * - `"clean"`: fresh app data every run without reinstalling an unchanged build.
 * - `"reinstall"`: uninstall, then install, every run.
 */
export const installModeSchema = z.enum(["clean", "reinstall"]);

export type InstallMode = z.infer<typeof installModeSchema>;

/**
 * `app` on a batch preset / e2e suite: `true` installs the project's app on every device first;
 * `{ installMode }` also resets the installed app (see {@link InstallMode}); `{ resetKeychain: true }`
 * (needs `installMode`) also resets the iOS simulator's keychain;
 * `{ variant }` installs that `projects[].variants` build instead of the project's default one.
 * `{ clean: true }` is the deprecated spelling of `{ installMode: "reinstall" }`.
 */
export const appOptionSchema = z.union([
	z.boolean(),
	z
		.object({
			installMode: installModeSchema.optional(),
			resetKeychain: z.boolean().optional(),
			/** @deprecated use `installMode: "reinstall"` */
			clean: z.boolean().optional(),
			variant: z.string().min(1).optional(),
		})
		.strict()
		.refine((app) => !(app.clean === true && app.installMode !== undefined), {
			message: "clean is the deprecated spelling of installMode: reinstall; don't set both",
		})
		.refine((app) => app.resetKeychain !== true || app.installMode !== undefined || app.clean === true, {
			message: "resetKeychain needs installMode",
		}),
]);

export type AppOption = z.infer<typeof appOptionSchema>;

export type AppSwitches = { app: boolean; installMode?: InstallMode; resetKeychain?: true; variant?: string };

/** The switches `app` stands for. An object means install (`app: {}` = `app: true`). */
export function appSwitches(app: AppOption | undefined): AppSwitches {
	if (app === undefined) return { app: false };
	if (typeof app === "boolean") return { app };
	const installMode = app.installMode ?? (app.clean === true ? "reinstall" : undefined);
	return {
		app: true,
		...(installMode !== undefined ? { installMode } : {}),
		...(installMode !== undefined && app.resetKeychain === true ? { resetKeychain: true as const } : {}),
		...(app.variant !== undefined ? { variant: app.variant } : {}),
	};
}
