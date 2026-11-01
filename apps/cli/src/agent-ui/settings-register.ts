import type { Command as Commander } from "@commander-js/extra-typings";
import type { CommandContext } from "../context";
import type { UiDeps } from "./driver";
import { uiOptionsHelper } from "./ui-options";

const APP = "--app <bundle>";
const APP_HELP = "the app's bundle id / package (default: the app `open` launched)";

export class UiSettingsRegister {
	/**
	 * Device settings a test starts from: `warden ui permission | timezone | locale | a11y | battery | memory-warning |
	 * push`. Each is its own verb (like `location` and `clock`) so `--help` shows its own flags; they share the lease's
	 * condition store, so release undoes them. One call from `commands/ui.ts`; `settings.ts` is imported by the one that runs.
	 */
	registerSettingsCommands(cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: UiDeps): void {
		uiOptionsHelper
			.withUiOptions(
				cmd
					.command("permission")
					.description("app permissions: set <name>=<granted|denied|unset>... | reset | status")
					.argument("<action>", "set | reset | status")
					.argument(
						"[pairs...]",
						"set: location=denied camera=granted ... (location, locationAlways, camera, photos, ...)"
					)
					.option(APP, APP_HELP)
			)
			.action(async (action, pairs, opts) => {
				const { uiSettings } = await import("./settings");
				done(await uiSettings.uiPermission(ctx, deps, action, pairs, opts));
			});
		uiOptionsHelper
			.withUiOptions(
				cmd
					.command("timezone")
					.description("device timezone: <IANA name> | reset | status (iOS: applies to the app launched next)")
					.argument("<tz>", "Pacific/Auckland | reset | status")
			)
			.action(async (tz, opts) => {
				const { uiSettings } = await import("./settings");
				done(await uiSettings.uiTimezone(ctx, deps, tz, opts));
			});
		uiOptionsHelper
			.withUiOptions(
				cmd
					.command("locale")
					.description(
						"the app's locale: <BCP 47 tag> | reset | status (Android 13+; iOS: applies to the app launched next)"
					)
					.argument("<tag>", "fr-FR | reset | status")
					.option(APP, APP_HELP)
			)
			.action(async (tag, opts) => {
				const { uiSettings } = await import("./settings");
				done(await uiSettings.uiLocale(ctx, deps, tag, opts));
			});
		uiOptionsHelper
			.withUiOptions(
				cmd
					.command("a11y")
					.description("accessibility: set [--text-size] [--bold] [--contrast] [--reduce-motion] | reset | status")
					.argument("<action>", "set | reset | status")
					.option("--text-size <size>", "a name (accessibility-large, extra-large, ...) or a font scale (1.5)")
					.option("--bold", "bold text (Android)")
					.option("--no-bold", "bold text off")
					.option("--contrast <mode>", "increased | normal (iOS)")
					.option("--reduce-motion", "reduce motion (no mechanism on either platform: reported as skipped)")
					.option("--no-reduce-motion", "reduce motion off")
			)
			.action(async (action, opts) => {
				const { uiSettings } = await import("./settings");
				done(await uiSettings.uiA11y(ctx, deps, action, opts));
			});
		uiOptionsHelper
			.withUiOptions(
				cmd
					.command("battery")
					.description(
						"battery: set [--level] [--charging] | reset | status (Android emulator real; iOS status bar only)"
					)
					.argument("<action>", "set | reset | status")
					.option("--level <percent>", "0-100")
					.option("--charging", "plugged in and charging")
					.option("--no-charging", "on battery")
			)
			.action(async (action, opts) => {
				const { uiSettings } = await import("./settings");
				done(await uiSettings.uiBattery(ctx, deps, action, opts));
			});
		uiOptionsHelper
			.withUiOptions(
				cmd
					.command("memory-warning")
					.description("send the running app a memory warning (Android only: iOS has no mechanism that works)")
					.option(APP, APP_HELP)
			)
			.action(async (opts) => {
				const { uiSettings } = await import("./settings");
				done(await uiSettings.uiMemoryWarning(ctx, deps, opts));
			});
		uiOptionsHelper
			.withUiOptions(
				cmd
					.command("push")
					.description(
						"deliver a push notification to the app (iOS only): a JSON file or inline JSON with an `aps` object"
					)
					.argument("<payload>", 'payload.json | \'{"aps":{"alert":"hi"}}\'')
					.option(APP, APP_HELP)
			)
			.action(async (payload, opts) => {
				const { uiSettings } = await import("./settings");
				done(await uiSettings.uiPush(ctx, deps, payload, opts));
			});
	}
}

export const uiSettingsRegister = new UiSettingsRegister();
