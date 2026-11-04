import type { Command as Commander } from "@commander-js/extra-typings";
import type { CommandContext } from "../context";
import type { UiDeps } from "./driver";
import { withUiOptions } from "./ui-options";

const APP = "--app <bundle>";

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}
const APP_HELP = "the app's bundle id / package (default: the app `open` launched)";

/**
 * Device settings a test starts from: `warden ui permission | timezone | locale | a11y | battery | memory-warning |
 * push`. Each is its own verb (like `location` and `clock`) so `--help` shows its own flags; they share the lease's
 * condition store, so release undoes them. One call from `commands/ui.ts`; `settings.ts` is imported by the one that runs.
 */
export function registerSettingsCommands(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: UiDeps
): void {
	withUiOptions(
		cmd
			.command("permission")
			.description("app permissions: set <name>=<granted|denied|unset>... | reset | status")
			.argument("<action>", "set | reset | status")
			.argument("[pairs...]", "set: location=denied camera=granted ... (location, locationAlways, camera, photos, ...)")
			.option(APP, APP_HELP)
	).action(async (action, pairs, opts) => {
		const { uiPermission } = await import("./settings");
		done(await uiPermission(ctx, deps, action, pairs, opts));
	});
	withUiOptions(
		cmd
			.command("timezone")
			.description("device timezone: <IANA name> | reset | status (iOS: applies to the app launched next)")
			.argument("<tz>", "Pacific/Auckland | reset | status")
	).action(async (tz, opts) => {
		const { uiTimezone } = await import("./settings");
		done(await uiTimezone(ctx, deps, tz, opts));
	});
	withUiOptions(
		cmd
			.command("locale")
			.description(
				"the app's locale: <BCP 47 tag> | reset | status (Android 13+; iOS: applies to the app launched next)"
			)
			.argument("<tag>", "fr-FR | reset | status")
			.option(APP, APP_HELP)
	).action(async (tag, opts) => {
		const { uiLocale } = await import("./settings");
		done(await uiLocale(ctx, deps, tag, opts));
	});
	withUiOptions(
		cmd
			.command("a11y")
			.description(
				"accessibility: set [--text-size] [--bold] [--screen-reader] … | reset | status | audit | order | speak <locator> | announcements | spoken | focus next|prev|activate|status"
			)
			.argument("<action>", "set | reset | status | audit | order | speak | announcements | spoken | focus")
			.argument("[args...]", "speak: a locator (@e3, id=…, label=…); focus: next | prev | activate | status")
			.option(
				"--text-size <size>",
				"a name (accessibility-large, extra-large, ...) or a font scale (1.5); audit: the size the app runs at"
			)
			.option("--bold", "bold text")
			.option("--no-bold", "bold text off")
			.option("--contrast <mode>", "increased | normal (iOS)")
			.option(
				"--reduce-motion",
				"reduce motion (Android: transition animations off; the e2e driver turns them off anyway)"
			)
			.option("--no-reduce-motion", "reduce motion off")
			.option(
				"--screen-reader",
				"screen reader on: iOS a simulated VoiceOver flag, Android real TalkBack (emulator, Play image)"
			)
			.option("--no-screen-reader", "screen reader off (Android: the previous accessibility services come back)")
			.option("--reduce-transparency", "reduce transparency (iOS)")
			.option("--no-reduce-transparency", "reduce transparency off")
			.option("--button-shapes", "button shapes (iOS)")
			.option("--no-button-shapes", "button shapes off")
			.option("--differentiate-without-color", "differentiate without colour (iOS)")
			.option("--no-differentiate-without-color", "differentiate without colour off")
			.option("--on-off-labels", "on/off labels on switches (iOS)")
			.option("--no-on-off-labels", "on/off labels off")
			.option("--high-contrast-text", "high contrast text (Android)")
			.option("--no-high-contrast-text", "high contrast text off")
			.option("--color-inversion", "colour inversion (Android)")
			.option("--no-color-inversion", "colour inversion off")
			.option("--rule <id>", "audit: only this rule (repeat for several)", collect, [] as string[])
			.option(
				"--ignore <rule[:identifier]>",
				"audit: drop a rule, or only on the element with that id (repeatable)",
				collect,
				[] as string[]
			)
			.option("--min-severity <severity>", "audit: lowest severity that fails, error (default) | warning")
			.option("--no-native", "audit: warden's rules only, no XCUITest / ATF")
			.option("--since <cursor>", "announcements, spoken: only what came after this cursor")
	).action(async (action, args, opts) => {
		const { uiA11y } = await import("./settings");
		done(await uiA11y(ctx, deps, action, args, opts));
	});
	withUiOptions(
		cmd
			.command("battery")
			.description("battery: set [--level] [--charging] | reset | status (Android emulator real; iOS status bar only)")
			.argument("<action>", "set | reset | status")
			.option("--level <percent>", "0-100")
			.option("--charging", "plugged in and charging")
			.option("--no-charging", "on battery")
	).action(async (action, opts) => {
		const { uiBattery } = await import("./settings");
		done(await uiBattery(ctx, deps, action, opts));
	});
	withUiOptions(
		cmd
			.command("memory-warning")
			.description("send the running app a memory warning (Android only: iOS has no mechanism that works)")
			.option(APP, APP_HELP)
	).action(async (opts) => {
		const { uiMemoryWarning } = await import("./settings");
		done(await uiMemoryWarning(ctx, deps, opts));
	});
	withUiOptions(
		cmd
			.command("push")
			.description("deliver a push notification to the app (iOS only): a JSON file or inline JSON with an `aps` object")
			.argument("<payload>", 'payload.json | \'{"aps":{"alert":"hi"}}\'')
			.option(APP, APP_HELP)
	).action(async (payload, opts) => {
		const { uiPush } = await import("./settings");
		done(await uiPush(ctx, deps, payload, opts));
	});
}
