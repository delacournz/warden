import { uiFill, uiKey, uiLongpress, uiPress, uiSwipe, uiType } from "../agent-ui/actions";
import { uiBench } from "../agent-ui/bench";
import { type CloseOptionValues, uiClose } from "../agent-ui/close";
import { uiAlert, uiAppearance, uiHardware, uiRotate, uiScreenshot } from "../agent-ui/controls";
import { registerDevtoolsCommands } from "../agent-ui/devtools-cli";
import { defaultUiDeps, type UiDeps } from "../agent-ui/driver";
import { registerFlowCommands } from "../agent-ui/flows-command";
import { uiOpen } from "../agent-ui/open";
import { uiGet, uiIs, uiWait } from "../agent-ui/query";
import { withUiOptions } from "../agent-ui/run";
import { uiScroll } from "../agent-ui/scroll";
import { uiFind, uiSnapshot } from "../agent-ui/snapshot-command";
import { uiStatus } from "../agent-ui/status";
import { uiVideo } from "../agent-ui/video";
import { type Command, defineCommand } from "../command";

/**
 * `warden ui <subcommand>`: drive a leased device for agents. Every subcommand is one `cmd.command(...)`
 * calling a function in `agent-ui/*.ts`, takes the options of `withUiOptions`, and honours the lease
 * rules of `resolveUiDevice` (the hook's `ensureCallerLease`). Exit codes: 0 ok · 1 failed/usage · 2 lease
 * · 3 engine unavailable · 4 stale ref · 130 interrupted. `deps` injects the driver + clock for tests.
 */
export function createUiCommand(deps: UiDeps): Command {
	return defineCommand({
		name: "ui",
		summary: "drive a leased simulator / emulator (agents): status, snapshot, find, open, press, fill, scroll, …",
		register: (cmd, ctx, done) => {
			withUiOptions(cmd.command("status").description("device, lease, helper and recording state")).action(
				async (opts) => done(await uiStatus(ctx, deps, opts))
			);
			withUiOptions(
				cmd
					.command("close")
					.description(
						"stop this device's helper (the lease stays); --app also quits the app, --release frees the lease"
					)
					.option("--app [bundleId]", "terminate the app first (default: the one `open` launched)")
					.option("--release", "release the lease too (stops the helper)")
			).action(async (opts: CloseOptionValues) => done(await uiClose(ctx, deps, opts)));
			withUiOptions(
				cmd
					.command("snapshot")
					.description("the screen as @eN lines (bumps the generation)")
					.option("-i, --interactive", "only interactive elements and anything with a testID")
					.option("--all", "no line cap")
					.option("--settle [ms]", "wait for a quiet screen (default budget 3000 ms), then print a +/-/= diff")
					.option("--depth <n>", "only the first n levels of the tree")
			).action(async (opts) => done(await uiSnapshot(ctx, deps, opts)));
			withUiOptions(
				cmd
					.command("find")
					.description("elements matching a selector, with @eN refs (bumps the generation)")
					.argument("<selector...>", "id=… label=… text=… role=… value=… editable=… nth=…")
			).action(async (selector, opts) => done(await uiFind(ctx, deps, selector, opts)));
			const SETTLE = "wait for a quiet screen afterwards (default budget 3000 ms) and print what changed";
			withUiOptions(
				cmd
					.command("open")
					.description("launch an app (bundle id) or open a URL; --metro starts the dev client on that Metro")
					.argument("<target>", "bundle id or URL")
					.option("--relaunch", "terminate a running app first")
					.option("--metro <url>", "Metro URL: launch with --initialUrl and remember it")
					.option("--args <args...>", "extra launch arguments")
					.option("--settle [ms]", SETTLE)
			).action(async (target, opts) => done(await uiOpen(ctx, deps, target, opts)));
			for (const name of ["press", "tap"] as const) {
				withUiOptions(
					cmd
						.command(name)
						.description("tap an element or point; an @eN older than 30 s is re-verified first")
						.argument("<target...>", "@eN | selector | x y")
						.option("--verify", "re-check an @eN against a fresh snapshot before tapping")
						.option("--settle [ms]", SETTLE)
				).action(async (words, opts) => done(await uiPress(ctx, deps, words, opts, name)));
			}
			withUiOptions(
				cmd
					.command("longpress")
					.description("press and hold an element or point (default 800 ms)")
					.argument("<target...>", "@eN | selector | x y, then optionally the duration in ms")
					.option("--verify", "re-check an @eN against a fresh snapshot first")
					.option("--settle [ms]", SETTLE)
			).action(async (words, opts) => done(await uiLongpress(ctx, deps, words, opts)));
			withUiOptions(
				cmd
					.command("fill")
					.description("replace a text field's content, then read it back (use -- before text starting with -)")
					.argument("<args...>", "<target> <text>: the last word is the text")
					.option("--secure", "password field: skip the read-back, never echo or record the text")
					.option("--no-verify", "skip the read-back")
					.option("--settle [ms]", SETTLE)
			).action(async (words, opts) => done(await uiFill(ctx, deps, words, opts)));
			withUiOptions(
				cmd
					.command("type")
					.description("type into whatever has focus")
					.argument("<text>", "text to type")
					.option("--submit", "then press Enter")
					.option("--settle [ms]", SETTLE)
			).action(async (text, opts) => done(await uiType(ctx, deps, text, opts)));
			withUiOptions(
				cmd
					.command("key")
					.description("press a key: Enter Backspace Tab Space Escape Delete Up Down Left Right")
					.argument("<name>", "key name")
					.option("--settle [ms]", SETTLE)
			).action(async (name, opts) => done(await uiKey(ctx, deps, name, opts)));
			withUiOptions(
				cmd
					.command("swipe")
					.description("raw swipe: the way the finger moves (swipe up reveals what is below), or x1 y1 x2 y2")
					.argument("<args...>", "up | down | left | right | x1 y1 x2 y2")
					.option("--from <target>", "swipe inside this element instead of the whole screen")
					.option("--settle [ms]", SETTLE)
			).action(async (words, opts) => done(await uiSwipe(ctx, deps, words, opts)));
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
			).action(async (direction, amount, opts) => done(await uiScroll(ctx, deps, direction, amount, opts)));
			withUiOptions(
				cmd
					.command("alert")
					.description("answer the system alert / sheet on top, or read it")
					.argument("<action>", "accept | dismiss | get")
					.option("--settle [ms]", SETTLE)
			).action(async (action, opts) => done(await uiAlert(ctx, deps, action, opts)));
			for (const button of ["home", "back"] as const) {
				withUiOptions(
					cmd
						.command(button)
						.description(button === "home" ? "press the home button" : "press back (Android only)")
						.option("--settle [ms]", SETTLE)
				).action(async (opts) => done(await uiHardware(ctx, deps, button, opts)));
			}
			withUiOptions(
				cmd
					.command("rotate")
					.description("set the orientation (none = read it)")
					.argument("[orientation]", "portrait | portrait-upside-down | landscape-left | landscape-right")
					.option("--settle [ms]", SETTLE)
			).action(async (orientation, opts) => done(await uiRotate(ctx, deps, orientation, opts)));
			withUiOptions(
				cmd
					.command("appearance")
					.description("set light or dark mode (none = read it)")
					.argument("[mode]", "light | dark")
					.option("--settle [ms]", SETTLE)
			).action(async (mode, opts) => done(await uiAppearance(ctx, deps, mode, opts)));
			withUiOptions(
				cmd
					.command("screenshot")
					.description("save a PNG of the screen (default: $WARDEN_HOME/ui/<udid>/shots/NNN.png)")
					.argument("[path]", "output file")
			).action(async (path, opts) => done(await uiScreenshot(ctx, deps, path, opts)));
			withUiOptions(
				cmd
					.command("video")
					.description("record the screen: video start [path] | video stop")
					.argument("<action>", "start | stop")
					.argument("[path]", "output file for start")
			).action(async (action, path, opts) => done(await uiVideo(ctx, deps, action, path, opts)));
			withUiOptions(
				cmd
					.command("wait")
					.description(
						"poll (100 ms, --timeout) until an element is visible; also: absent <sel> | text <…> | stable [ms]"
					)
					.argument("<args...>", "<selector> | absent <selector> | text <text> | stable [ms]")
			).action(async (words, opts) => done(await uiWait(ctx, deps, words, opts)));
			withUiOptions(
				cmd
					.command("is")
					.description("exit 0 when the element is in that state, 1 when not")
					.argument("<args...>", "<selector> visible|hittable|enabled|checked|selected|focused")
			).action(async (words, opts) => done(await uiIs(ctx, deps, words, opts)));
			withUiOptions(
				cmd
					.command("get")
					.description("print one property of an element (count = how many match)")
					.argument("<args...>", "<selector> text|value|label|id|role|frame|count")
			).action(async (words, opts) => done(await uiGet(ctx, deps, words, opts)));
			withUiOptions(
				cmd
					.command("bench")
					.description("time snapshot, press, settle, tree and driver open on this device against the speed targets")
					.option("--runs <n>", "samples per metric (default 20; cold start, settle and open are capped at 3-5)")
					.option("--metro <url>", "Metro URL for the tree metric")
			).action(async (opts) => done(await uiBench(ctx, deps, opts)));
			registerFlowCommands(cmd, ctx, done, deps);
			registerDevtoolsCommands(cmd, ctx, done, deps);
		},
	});
}

export const uiCommand = createUiCommand(defaultUiDeps);
