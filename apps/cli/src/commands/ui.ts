import { registerAuthoringCommands } from "../agent-ui/authoring-register";
import type { CloseOptionValues } from "../agent-ui/close";
import { registerDevtoolsCommands } from "../agent-ui/devtools-register";
import { defaultUiDeps, type UiDeps } from "../agent-ui/driver";
import { withUiOptions } from "../agent-ui/ui-options";
import { type Command, defineCommand } from "../command";
import { kindOption } from "../install-flags";

/**
 * `warden ui <subcommand>`: drive a leased device for agents. Every subcommand is one `cmd.command(...)`
 * that imports its function from `agent-ui/*.ts` when it runs (a call loads only its own module, and the driver
 * only when it opens a device), takes the options of `withUiOptions`, and honours the lease
 * rules of `resolveUiDevice` (the hook's `ensureCallerLease`). Exit codes: 0 ok · 1 failed/usage · 2 lease
 * · 3 engine unavailable · 4 stale ref · 130 interrupted. `deps` injects the driver + clock for tests.
 */
/** Commander accumulator for a repeatable `--path`. */
function collectPath(value: string, previous: string[]): string[] {
	return [...previous, value];
}

export function createUiCommand(deps: UiDeps): Command {
	return defineCommand({
		name: "ui",
		summary: "drive a leased simulator / emulator (agents): status, snapshot, find, open, press, fill, scroll, …",
		register: (cmd, ctx, done) => {
			withUiOptions(cmd.command("status").description("device, lease, helper and recording state")).action(
				async (opts) => {
					const { uiStatus } = await import("../agent-ui/status");
					done(await uiStatus(ctx, deps, opts));
				}
			);
			withUiOptions(
				cmd
					.command("close")
					.description(
						"stop this device's helper (the lease stays); --app also quits the app, --release frees the lease"
					)
					.option("--app [bundleId]", "terminate the app first (default: the one `open` launched)")
					.option("--release", "release the lease too (stops the helper)")
			).action(async (opts: CloseOptionValues) => {
				const { uiClose } = await import("../agent-ui/close");
				done(await uiClose(ctx, deps, opts));
			});
			withUiOptions(
				cmd
					.command("snapshot")
					.description("the screen as @eN lines (bumps the generation)")
					.option("-i, --interactive", "only interactive elements and anything with a testID")
					.option("--all", "no line cap")
					.option("--settle [ms]", "wait for a quiet screen (default budget 3000 ms), then print a +/-/= diff")
					.option("--depth <n>", "only the first n levels of the tree")
			).action(async (opts) => {
				const { uiSnapshot } = await import("../agent-ui/snapshot-command");
				done(await uiSnapshot(ctx, deps, opts));
			});
			withUiOptions(
				cmd
					.command("find")
					.description("elements matching a selector, with @eN refs (bumps the generation)")
					.argument("<selector...>", "id=… label=… text=… role=… value=… editable=… nth=…")
			).action(async (selector, opts) => {
				const { uiFind } = await import("../agent-ui/snapshot-command");
				done(await uiFind(ctx, deps, selector, opts));
			});
			const SETTLE = "wait for a quiet screen afterwards (default budget 3000 ms) and print what changed";
			withUiOptions(
				cmd
					.command("open")
					.description(
						"launch an app (bundle id) or open a URL; --metro starts the dev client on that Metro; --kind installs that build first"
					)
					.argument("<target>", "bundle id or URL")
					.option("--relaunch", "terminate a running app first")
					.option("--metro <url>", "Metro URL: launch with --initialUrl and remember it")
					.option("--args <args...>", "extra launch arguments")
					.addOption(kindOption())
					.option("--project <dir>", "--kind: the app's project directory (default: cwd)")
					.option("--settle [ms]", SETTLE)
			).action(async (target, opts) => {
				const { uiOpen } = await import("../agent-ui/open");
				done(await uiOpen(ctx, deps, target, opts));
			});
			for (const name of ["press", "tap"] as const) {
				withUiOptions(
					cmd
						.command(name)
						.description("tap an element or point; an @eN older than 30 s is re-verified first")
						.argument("<target...>", "@eN | selector | x y")
						.option("--verify", "re-check an @eN against a fresh snapshot before tapping")
						.option("--settle [ms]", SETTLE)
				).action(async (words, opts) => {
					const { uiPress } = await import("../agent-ui/actions");
					done(await uiPress(ctx, deps, words, opts, name));
				});
			}
			withUiOptions(
				cmd
					.command("fill")
					.description("replace a text field's content, then read it back (use -- before text starting with -)")
					.argument("<args...>", "<target> <text>: the last word is the text")
					.option("--secure", "password field: skip the read-back, never echo or record the text")
					.option("--no-verify", "skip the read-back")
					.option(
						"--via <mode>",
						"type (default; one key per character) or paste (iOS pastes through the pasteboard Xcode syncs with the Mac clipboard)"
					)
					.option("--settle [ms]", SETTLE)
			).action(async (words, opts) => {
				const { uiFill } = await import("../agent-ui/actions");
				done(await uiFill(ctx, deps, words, opts));
			});
			withUiOptions(
				cmd
					.command("type")
					.description("type into whatever has focus")
					.argument("<text>", "text to type")
					.option("--submit", "then press Enter")
					.option("--settle [ms]", SETTLE)
			).action(async (text, opts) => {
				const { uiType } = await import("../agent-ui/actions");
				done(await uiType(ctx, deps, text, opts));
			});
			withUiOptions(
				cmd
					.command("key")
					.description("press a key: Enter Backspace Tab Space Escape Delete Up Down Left Right")
					.argument("<name>", "key name")
					.option("--settle [ms]", SETTLE)
			).action(async (name, opts) => {
				const { uiKey } = await import("../agent-ui/actions");
				done(await uiKey(ctx, deps, name, opts));
			});
			withUiOptions(
				cmd
					.command("scroll")
					.description(
						"scroll content: scroll down reveals what is below; --until swipes until a selector is on screen"
					)
					.argument("<direction>", "up | down | left | right")
					.argument("[amount]", "share of the region one swipe travels, 0-1 (default 0.5)")
					.option("--until <selector>", "keep scrolling until this selector is on screen")
					.option("--in <target>", "scroll inside this element (@eN or selector)")
					.option("--max <n>", "give up after n swipes with --until (default 10)")
					.option("--settle [ms]", SETTLE)
			).action(async (direction, amount, opts) => {
				const { uiScroll } = await import("../agent-ui/scroll");
				done(await uiScroll(ctx, deps, direction, amount, opts));
			});
			withUiOptions(
				cmd
					.command("alert")
					.description("answer the system alert / sheet on top, or read it")
					.argument("<action>", "accept | dismiss | get")
					.option("--settle [ms]", SETTLE)
			).action(async (action, opts) => {
				const { uiAlert } = await import("../agent-ui/controls");
				done(await uiAlert(ctx, deps, action, opts));
			});
			for (const button of ["home", "back"] as const) {
				withUiOptions(
					cmd
						.command(button)
						.description(button === "home" ? "press the home button" : "press back (Android only)")
						.option("--settle [ms]", SETTLE)
				).action(async (opts) => {
					const { uiHardware } = await import("../agent-ui/controls");
					done(await uiHardware(ctx, deps, button, opts));
				});
			}
			withUiOptions(
				cmd
					.command("biometrics")
					.description("simulated Face ID / Touch ID / fingerprint: status (default), enroll, unenroll, match, fail")
					.argument("[op]", "status | enroll | unenroll | match | fail")
					.option("--settle [ms]", SETTLE)
			).action(async (op, opts) => {
				const { uiBiometrics } = await import("../agent-ui/controls");
				done(await uiBiometrics(ctx, deps, op, opts));
			});
			const screen = cmd.command("screen").description("the device screen: orientation, appearance, screenshot, video");
			withUiOptions(
				screen
					.command("rotate")
					.description("set the orientation (none = read it)")
					.argument("[orientation]", "portrait | portrait-upside-down | landscape-left | landscape-right")
					.option("--settle [ms]", SETTLE)
			).action(async (orientation, opts) => {
				const { uiRotate } = await import("../agent-ui/controls");
				done(await uiRotate(ctx, deps, orientation, opts));
			});
			withUiOptions(
				screen
					.command("appearance")
					.description("set light or dark mode (none = read it)")
					.argument("[mode]", "light | dark")
					.option("--settle [ms]", SETTLE)
			).action(async (mode, opts) => {
				const { uiAppearance } = await import("../agent-ui/controls");
				done(await uiAppearance(ctx, deps, mode, opts));
			});
			withUiOptions(
				screen
					.command("screenshot")
					.description("save a PNG of the screen (default: $WARDEN_HOME/ui/<udid>/shots/NNN.png)")
					.argument("[path]", "output file")
			).action(async (path, opts) => {
				const { uiScreenshot } = await import("../agent-ui/controls");
				done(await uiScreenshot(ctx, deps, path, opts));
			});
			withUiOptions(
				screen
					.command("video")
					.description("record the screen: video start [path] | video stop")
					.argument("<action>", "start | stop")
					.argument("[path]", "output file for start")
			).action(async (action, path, opts) => {
				const { uiVideo } = await import("../agent-ui/video");
				done(await uiVideo(ctx, deps, action, path, opts));
			});
			const gesture = cmd.command("gesture").description("touch gestures: swipe, longpress, pinch, rotate, raw paths");
			withUiOptions(
				gesture
					.command("swipe")
					.description("raw swipe: the way the finger moves (swipe up reveals what is below), or x1 y1 x2 y2")
					.argument("<args...>", "up | down | left | right | x1 y1 x2 y2")
					.option("--from <target>", "swipe inside this element instead of the whole screen")
					.option("--settle [ms]", SETTLE)
			).action(async (words, opts) => {
				const { uiSwipe } = await import("../agent-ui/actions");
				done(await uiSwipe(ctx, deps, words, opts));
			});
			withUiOptions(
				gesture
					.command("longpress")
					.description("press and hold an element or point (default 800 ms)")
					.argument("<target...>", "@eN | selector | x y, then optionally the duration in ms")
					.option("--verify", "re-check an @eN against a fresh snapshot first")
					.option("--settle [ms]", SETTLE)
			).action(async (words, opts) => {
				const { uiLongpress } = await import("../agent-ui/actions");
				done(await uiLongpress(ctx, deps, words, opts));
			});
			withUiOptions(
				gesture
					.command("pinch")
					.description(
						"two-finger pinch around an element, a point or the screen centre: scale > 1 spreads the fingers (zoom in), < 1 closes them"
					)
					.argument("<args...>", "[@eN | selector | x y] <scale>: the last word is the scale (0.1-10, not 1)")
					.option("--duration <ms>", "how long the gesture takes (default 500)")
					.option("--radius <n>", "finger distance from the centre at the start, in points")
					.option("--verify", "re-check an @eN against a fresh snapshot first")
					.option("--settle [ms]", SETTLE)
			).action(async (words, opts) => {
				const { uiGesturePinch } = await import("../agent-ui/gestures");
				done(await uiGesturePinch(ctx, deps, words, opts));
			});
			withUiOptions(
				gesture
					.command("rotate")
					.description("two-finger rotation (device orientation is `screen rotate`): positive degrees turn clockwise")
					.argument("<args...>", "[@eN | selector | x y] <degrees>: the last word is the angle (not 0, at most 720)")
					.option("--duration <ms>", "how long the gesture takes (default 500)")
					.option("--radius <n>", "finger distance from the centre, in points")
					.option("--verify", "re-check an @eN against a fresh snapshot first")
					.option("--settle [ms]", SETTLE)
			).action(async (words, opts) => {
				const { uiGestureRotate } = await import("../agent-ui/gestures");
				done(await uiGestureRotate(ctx, deps, words, opts));
			});
			withUiOptions(
				gesture
					.command("path")
					.description("raw touch paths: one --path per finger (max 2), fingers go down and lift together")
					.option(
						"--path <points>",
						"one finger's route: x,y x,y … (repeat for a second finger)",
						collectPath,
						[] as string[]
					)
					.option("--duration <ms>", "how long the gesture takes (default 600)")
					.option("--settle [ms]", SETTLE)
			).action(async (opts) => {
				const { uiGesturePath } = await import("../agent-ui/gestures");
				done(await uiGesturePath(ctx, deps, opts));
			});
			withUiOptions(
				cmd
					.command("wait")
					.description(
						"poll (100 ms, --timeout) until an element is visible; also: absent <sel> | text <…> | stable [ms]"
					)
					.argument("<args...>", "<selector> | absent <selector> | text <text> | stable [ms]")
			).action(async (words, opts) => {
				const { uiWait } = await import("../agent-ui/query");
				done(await uiWait(ctx, deps, words, opts));
			});
			withUiOptions(
				cmd
					.command("is")
					.description("exit 0 when the element is in that state, 1 when not")
					.argument("<args...>", "<selector> visible|hittable|enabled|checked|selected|focused")
			).action(async (words, opts) => {
				const { uiIs } = await import("../agent-ui/query");
				done(await uiIs(ctx, deps, words, opts));
			});
			withUiOptions(
				cmd
					.command("get")
					.description("print one property of an element (count = how many match)")
					.argument("<args...>", "<selector> text|value|label|id|role|frame|count")
			).action(async (words, opts) => {
				const { uiGet } = await import("../agent-ui/query");
				done(await uiGet(ctx, deps, words, opts));
			});
			withUiOptions(
				cmd
					.command("bench")
					.description("time snapshot, press, settle, tree and driver open on this device against the speed targets")
					.option("--runs <n>", "samples per metric (default 20; cold start, settle and open are capped at 3-5)")
					.option("--metro <url>", "Metro URL for the tree metric")
			).action(async (opts) => {
				const { uiBench } = await import("../agent-ui/bench");
				done(await uiBench(ctx, deps, opts));
			});
			registerAuthoringCommands(cmd, ctx, done, deps);
			registerDevtoolsCommands(cmd, ctx, done, deps);
		},
	});
}

export const uiCommand = createUiCommand(defaultUiDeps);
