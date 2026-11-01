import type { ActionId, Mode } from "./model";

export class DevTuiKeys {
	key(name: string, seq: string, flags: { ctrl?: boolean; shift?: boolean } = {}): Key {
		return { name, ctrl: flags.ctrl ?? false, shift: flags.shift ?? false, seq };
	}

	private decodeChar(char: string): Key {
		const code = char.codePointAt(0) ?? 0;
		if (char === "\r" || char === "\n") return this.key("enter", char);
		if (char === "\t") return this.key("tab", char);
		if (code === 127 || code === 8) return this.key("backspace", char);
		if (code === 0) return this.key("space", char, { ctrl: true });
		if (code < 27) return this.key(String.fromCharCode(code + 96), char, { ctrl: true });
		if (char === " ") return this.key("space", char);
		return this.key(char, char, { shift: char.toLowerCase() !== char });
	}

	private csiStep(buf: string): Step {
		let end = 2;
		while (end < buf.length && !/[@-~]/.test(buf[end] ?? "")) end++;
		if (end >= buf.length) return "wait";
		const seq = buf.slice(0, end + 1);
		const final = buf[end] ?? "";
		const params = buf.slice(2, end);
		const used = end + 1;
		if (final === "Z") return { key: this.key("tab", seq, { shift: true }), used };
		if (final === "~")
			return {
				key: this.key(TILDE_NAMES[params.split(";")[0] ?? ""] ?? "unknown", seq, { shift: params.endsWith(";2") }),
				used,
			};
		return { key: this.key(CSI_NAMES[final] ?? "unknown", seq, { shift: params.endsWith(";2") }), used };
	}

	private step(buf: string): Step {
		if (buf[0] !== ESC) {
			const point = String.fromCodePoint(buf.codePointAt(0) ?? 0);
			return { key: this.decodeChar(point), used: point.length };
		}
		if (buf.length === 1) return "wait";
		if (buf[1] === "[") return this.csiStep(buf);
		if (buf[1] === "O") {
			if (buf.length < 3) return "wait";
			return { key: this.key(CSI_NAMES[buf[2] ?? ""] ?? "unknown", buf.slice(0, 3)), used: 3 };
		}
		return { key: this.key("escape", ESC), used: 1 };
	}

	/** Raw stdin bytes to keys. Keeps a partial UTF-8 / escape sequence between `feed` calls. */
	createKeyParser(onKey: (key: Key) => void, timers: KeyTimers = defaultTimers) {
		const decoder = new TextDecoder();
		let buf = "";
		let timer: unknown;

		const drain = (): void => {
			while (buf.length > 0) {
				const next = this.step(buf);
				if (next === "wait") return;
				buf = buf.slice(next.used);
				onKey(next.key);
			}
		};

		return {
			feed(chunk: Uint8Array | string): void {
				if (timer !== undefined) {
					timers.clear(timer);
					timer = undefined;
				}
				buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
				drain();
				if (buf.length > 0) {
					timer = timers.set(() => {
						timer = undefined;
						const pending = buf;
						buf = "";
						if (pending === ESC) onKey(devTuiKeys.key("escape", ESC));
					}, ESC_TIMEOUT_MS);
				}
			},
		};
	}

	named(...names: string[]) {
		return (k: Key): boolean => !k.ctrl && names.includes(k.name);
	}

	ctrl(name: string) {
		return (k: Key): boolean => k.ctrl && k.name === name;
	}

	run(keyName: string, desc: string, action: ActionId): Binding {
		return { label: keyName, desc, match: this.named(keyName), action: { type: "run", action } };
	}

	shifted(name: string) {
		return (k: Key): boolean => k.shift && k.name === name;
	}

	actionFor(mode: Mode, k: Key): Action | undefined {
		return BINDINGS[mode].find((b) => b.match(k))?.action;
	}

	/** What a key does to the prompt: Enter submits, Esc / Ctrl-C cancel, printable keys type. Anything else is ignored. */
	promptEdit(k: Key): PromptEdit | undefined {
		if (k.ctrl) return k.name === "c" ? { op: "cancel" } : undefined;
		if (k.name === "enter") return { op: "submit" };
		if (k.name === "escape") return { op: "cancel" };
		if (k.name === "backspace") return { op: "backspace" };
		if (k.name === "space") return { op: "char", char: " " };
		if ([...k.name].length === 1) return { op: "char", char: k.name };
		return undefined;
	}

	/** Footer hint per mode. */
	footerHint(mode: Mode): string {
		switch (mode) {
			case "list":
				return "↑↓ select · enter interact · tab log · ? help · q quit";
			case "log":
				return "↑↓ scroll · pgup/pgdn page · g/G top/bottom · tab back · q quit";
			case "interact":
				return "Esc back · keys go to Expo · Shift+PgUp/PgDn scroll";
			case "help":
				return "esc close · ctrl-c quit";
			case "prompt":
				return "enter add · esc cancel";
		}
	}
}

export const devTuiKeys = new DevTuiKeys();

/** One decoded key press. `name` is the character itself for printable keys (`R` has `shift`), else a word. */
export type Key = { name: string; ctrl: boolean; shift: boolean; seq: string };

const ESC = "\x1b";
const CSI_NAMES: Record<string, string> = {
	A: "up",
	B: "down",
	C: "right",
	D: "left",
	H: "home",
	F: "end",
};
const TILDE_NAMES: Record<string, string> = {
	"1": "home",
	"3": "delete",
	"4": "end",
	"5": "pgup",
	"6": "pgdn",
	"7": "home",
	"8": "end",
};

/** One key and the bytes it used, or "wait" when the buffer ends inside a sequence. */
type Step = { key: Key; used: number } | "wait";

export type KeyTimers = {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
};

const defaultTimers: KeyTimers = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Wait this long after a bare Esc (or a cut-off sequence) before calling it a lone Esc. */
export const ESC_TIMEOUT_MS = 25;

export type ScrollKind = "line" | "page" | "top" | "bottom";

/** What a key does. The reducer applies it; the host reacts to `quit`. */
export type Action =
	| { type: "select"; delta: 1 | -1 }
	| { type: "scroll"; kind: ScrollKind; dir: 1 | -1 }
	| { type: "mode"; mode: Mode }
	/** select the Metro row and send every key to Expo until Esc */
	| { type: "interact" }
	/** interact mode: this key belongs to Expo (the host writes its bytes to the Metro PTY) */
	| { type: "forward" }
	/** interact mode: scroll the Metro pane into its history (`dir` 1) or back (`dir` -1); the host applies it */
	| { type: "pane-scroll"; dir: 1 | -1 }
	| { type: "quit" }
	| { type: "hud" }
	| { type: "redraw" }
	/** run a warden action; the host does the work (`actions.ts`), the reducer ignores it */
	| { type: "run"; action: ActionId };

export type Binding = {
	/** keycaps for the help overlay */
	label: string;
	desc: string;
	match(key: Key): boolean;
	action: Action;
	/** left out of the help overlay (the second half of a pair) */
	hidden?: boolean;
};

const QUIT: Binding = {
	label: "q ctrl-c",
	desc: "quit, release",
	match: (k) => devTuiKeys.named("q")(k) || devTuiKeys.ctrl("c")(k),
	action: { type: "quit" },
};
const REDRAW: Binding = { label: "ctrl-l", desc: "redraw", match: devTuiKeys.ctrl("l"), action: { type: "redraw" } };

/** List mode. */
export const LIST_BINDINGS: readonly Binding[] = [
	{ label: "↑ ↓ j k", desc: "select task", match: devTuiKeys.named("up", "k"), action: { type: "select", delta: -1 } },
	{ label: "", desc: "", match: devTuiKeys.named("down", "j"), action: { type: "select", delta: 1 }, hidden: true },
	{ label: "enter i", desc: "interact Metro", match: devTuiKeys.named("enter", "i"), action: { type: "interact" } },
	{ label: "tab", desc: "focus log", match: devTuiKeys.named("tab"), action: { type: "mode", mode: "log" } },
	devTuiKeys.run("r", "reload app", "reload"),
	devTuiKeys.run("d", "show sim", "show"),
	devTuiKeys.run("o", "open client", "open"),
	devTuiKeys.run("s", "screenshot", "screenshot"),
	devTuiKeys.run("R", "reinstall app", "reinstall"),
	devTuiKeys.run("x", "restart sim", "restart-sim"),
	devTuiKeys.run("c", "Metro --clear", "metro-clear"),
	devTuiKeys.run("l", "device logs", "logs"),
	devTuiKeys.run("p", "perf on/off", "perf"),
	devTuiKeys.run("P", "perf all", "perf-all"),
	devTuiKeys.run("m", "perf mark", "mark"),
	devTuiKeys.run("f", "frames", "frames"),
	devTuiKeys.run("g", "perf report", "report"),
	{ label: "h", desc: "toggle HUD", match: devTuiKeys.named("h"), action: { type: "hud" } },
	{ label: "?", desc: "help", match: devTuiKeys.named("?"), action: { type: "mode", mode: "help" } },
	QUIT,
	REDRAW,
];

/** Log pane focus. */
export const LOG_BINDINGS: readonly Binding[] = [
	{
		label: "↑ ↓",
		desc: "scroll line",
		match: devTuiKeys.named("up", "k"),
		action: { type: "scroll", kind: "line", dir: 1 },
	},
	{
		label: "",
		desc: "",
		match: devTuiKeys.named("down", "j"),
		action: { type: "scroll", kind: "line", dir: -1 },
		hidden: true,
	},
	{
		label: "pgup pgdn",
		desc: "scroll page",
		match: devTuiKeys.named("pgup"),
		action: { type: "scroll", kind: "page", dir: 1 },
	},
	{
		label: "",
		desc: "",
		match: devTuiKeys.named("pgdn"),
		action: { type: "scroll", kind: "page", dir: -1 },
		hidden: true,
	},
	{ label: "g G", desc: "top / bottom", match: devTuiKeys.named("g"), action: { type: "scroll", kind: "top", dir: 1 } },
	{
		label: "",
		desc: "",
		match: devTuiKeys.named("G"),
		action: { type: "scroll", kind: "bottom", dir: -1 },
		hidden: true,
	},
	{
		label: "tab esc",
		desc: "back to list",
		match: devTuiKeys.named("tab", "escape"),
		action: { type: "mode", mode: "list" },
	},
	QUIT,
	REDRAW,
];

/** The overlay closes on these; Ctrl-C still quits. */
export const HELP_BINDINGS: readonly Binding[] = [
	{
		label: "esc ? q",
		desc: "close",
		match: devTuiKeys.named("escape", "?", "q", "enter"),
		action: { type: "mode", mode: "list" },
	},
	{ label: "ctrl-c", desc: "quit, release", match: devTuiKeys.ctrl("c"), action: { type: "quit" } },
];

/** Interact mode (Metro pane): Esc and Shift+PgUp/PgDn are ours, every other key (Ctrl-C too) is Expo's. */
export const INTERACT_BINDINGS: readonly Binding[] = [
	{ label: "esc", desc: "back to list", match: devTuiKeys.named("escape"), action: { type: "mode", mode: "list" } },
	{
		label: "shift+pgup",
		desc: "scroll pane up",
		match: devTuiKeys.shifted("pgup"),
		action: { type: "pane-scroll", dir: 1 },
	},
	{
		label: "shift+pgdn",
		desc: "scroll pane down",
		match: devTuiKeys.shifted("pgdn"),
		action: { type: "pane-scroll", dir: -1 },
	},
	{ label: "any", desc: "to Expo", match: () => true, action: { type: "forward" } },
];

const BINDINGS: Record<Mode, readonly Binding[]> = {
	list: LIST_BINDINGS,
	log: LOG_BINDINGS,
	help: HELP_BINDINGS,
	interact: INTERACT_BINDINGS,
	prompt: [],
};

/** One edit of the footer's input line. */
export type PromptEdit = { op: "char"; char: string } | { op: "backspace" } | { op: "submit" } | { op: "cancel" };

/** Expo's own keys, shown next to warden's in the help overlay (they apply in interact mode). */
export const EXPO_KEYS: ReadonlyArray<{ label: string; desc: string }> = [
	{ label: "a", desc: "open Android" },
	{ label: "i", desc: "open iOS sim" },
	{ label: "w", desc: "open web" },
	{ label: "j", desc: "open debugger" },
	{ label: "r", desc: "reload app" },
	{ label: "m", desc: "dev menu" },
	{ label: "shift+m", desc: "more tools" },
	{ label: "o", desc: "open in editor" },
	{ label: "?", desc: "all commands" },
];
