import type { Mode } from "./model";

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

function key(name: string, seq: string, flags: { ctrl?: boolean; shift?: boolean } = {}): Key {
	return { name, ctrl: flags.ctrl ?? false, shift: flags.shift ?? false, seq };
}

function decodeChar(char: string): Key {
	const code = char.codePointAt(0) ?? 0;
	if (char === "\r" || char === "\n") return key("enter", char);
	if (char === "\t") return key("tab", char);
	if (code === 127 || code === 8) return key("backspace", char);
	if (code === 0) return key("space", char, { ctrl: true });
	if (code < 27) return key(String.fromCharCode(code + 96), char, { ctrl: true });
	if (char === " ") return key("space", char);
	return key(char, char, { shift: char.toLowerCase() !== char });
}

/** One key and the bytes it used, or "wait" when the buffer ends inside a sequence. */
type Step = { key: Key; used: number } | "wait";

function csiStep(buf: string): Step {
	let end = 2;
	while (end < buf.length && !/[@-~]/.test(buf[end] ?? "")) end++;
	if (end >= buf.length) return "wait";
	const seq = buf.slice(0, end + 1);
	const final = buf[end] ?? "";
	const params = buf.slice(2, end);
	const used = end + 1;
	if (final === "Z") return { key: key("tab", seq, { shift: true }), used };
	if (final === "~") return { key: key(TILDE_NAMES[params.split(";")[0] ?? ""] ?? "unknown", seq), used };
	return { key: key(CSI_NAMES[final] ?? "unknown", seq, { shift: params.endsWith(";2") }), used };
}

function step(buf: string): Step {
	if (buf[0] !== ESC) {
		const point = String.fromCodePoint(buf.codePointAt(0) ?? 0);
		return { key: decodeChar(point), used: point.length };
	}
	if (buf.length === 1) return "wait";
	if (buf[1] === "[") return csiStep(buf);
	if (buf[1] === "O") {
		if (buf.length < 3) return "wait";
		return { key: key(CSI_NAMES[buf[2] ?? ""] ?? "unknown", buf.slice(0, 3)), used: 3 };
	}
	return { key: key("escape", ESC), used: 1 };
}

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

/** Raw stdin bytes to keys. Keeps a partial UTF-8 / escape sequence between `feed` calls. */
export function createKeyParser(onKey: (key: Key) => void, timers: KeyTimers = defaultTimers) {
	const decoder = new TextDecoder();
	let buf = "";
	let timer: unknown;

	const drain = (): void => {
		while (buf.length > 0) {
			const next = step(buf);
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
					if (pending === ESC) onKey(key("escape", ESC));
				}, ESC_TIMEOUT_MS);
			}
		},
	};
}

export type ScrollKind = "line" | "page" | "top" | "bottom";

/** What a key does. The reducer applies it; the host reacts to `quit`. */
export type Action =
	| { type: "select"; delta: 1 | -1 }
	| { type: "scroll"; kind: ScrollKind; dir: 1 | -1 }
	| { type: "mode"; mode: Mode }
	| { type: "quit" }
	| { type: "hud" }
	| { type: "redraw" }
	| { type: "unavailable"; label: string };

export type Binding = {
	/** keycaps for the help overlay */
	label: string;
	desc: string;
	match(key: Key): boolean;
	action: Action;
	/** left out of the help overlay (the second half of a pair) */
	hidden?: boolean;
};

const named =
	(...names: string[]) =>
	(k: Key): boolean =>
		!k.ctrl && names.includes(k.name);
const ctrl =
	(name: string) =>
	(k: Key): boolean =>
		k.ctrl && k.name === name;

const QUIT: Binding = {
	label: "q ctrl-c",
	desc: "quit, release",
	match: (k) => named("q")(k) || ctrl("c")(k),
	action: { type: "quit" },
};
const REDRAW: Binding = { label: "ctrl-l", desc: "redraw", match: ctrl("l"), action: { type: "redraw" } };

function todo(keyName: string, desc: string): Binding {
	return { label: keyName, desc, match: named(keyName), action: { type: "unavailable", label: desc } };
}

/** List mode. Entries not built yet log "not available yet" so the map is complete (TUI-4/5 replace the actions). */
export const LIST_BINDINGS: readonly Binding[] = [
	{ label: "↑ ↓ j k", desc: "select task", match: named("up", "k"), action: { type: "select", delta: -1 } },
	{ label: "", desc: "", match: named("down", "j"), action: { type: "select", delta: 1 }, hidden: true },
	{
		label: "enter i",
		desc: "interact Metro",
		match: named("enter", "i"),
		action: { type: "unavailable", label: "interact Metro" },
	},
	{ label: "tab", desc: "focus log", match: named("tab"), action: { type: "mode", mode: "log" } },
	todo("r", "reload app"),
	todo("d", "show sim"),
	todo("o", "open client"),
	todo("s", "screenshot"),
	todo("R", "reinstall app"),
	todo("x", "restart sim"),
	todo("c", "Metro --clear"),
	todo("l", "device logs"),
	todo("p", "perf on/off"),
	todo("P", "perf all"),
	todo("m", "perf mark"),
	todo("f", "frames"),
	todo("g", "perf report"),
	{ label: "h", desc: "toggle HUD", match: named("h"), action: { type: "hud" } },
	{ label: "?", desc: "help", match: named("?"), action: { type: "mode", mode: "help" } },
	QUIT,
	REDRAW,
];

/** Log pane focus. */
export const LOG_BINDINGS: readonly Binding[] = [
	{ label: "↑ ↓", desc: "scroll line", match: named("up", "k"), action: { type: "scroll", kind: "line", dir: 1 } },
	{ label: "", desc: "", match: named("down", "j"), action: { type: "scroll", kind: "line", dir: -1 }, hidden: true },
	{ label: "pgup pgdn", desc: "scroll page", match: named("pgup"), action: { type: "scroll", kind: "page", dir: 1 } },
	{ label: "", desc: "", match: named("pgdn"), action: { type: "scroll", kind: "page", dir: -1 }, hidden: true },
	{ label: "g G", desc: "top / bottom", match: named("g"), action: { type: "scroll", kind: "top", dir: 1 } },
	{ label: "", desc: "", match: named("G"), action: { type: "scroll", kind: "bottom", dir: -1 }, hidden: true },
	{ label: "tab esc", desc: "back to list", match: named("tab", "escape"), action: { type: "mode", mode: "list" } },
	QUIT,
	REDRAW,
];

/** The overlay closes on these; Ctrl-C still quits. */
export const HELP_BINDINGS: readonly Binding[] = [
	{
		label: "esc ? q",
		desc: "close",
		match: named("escape", "?", "q", "enter"),
		action: { type: "mode", mode: "list" },
	},
	{ label: "ctrl-c", desc: "quit, release", match: ctrl("c"), action: { type: "quit" } },
];

/** Interact mode (Metro pane, TUI-4): only Esc is ours. */
export const INTERACT_BINDINGS: readonly Binding[] = [
	{ label: "esc", desc: "back to list", match: named("escape"), action: { type: "mode", mode: "list" } },
];

const BINDINGS: Record<Mode, readonly Binding[]> = {
	list: LIST_BINDINGS,
	log: LOG_BINDINGS,
	help: HELP_BINDINGS,
	interact: INTERACT_BINDINGS,
};

export function actionFor(mode: Mode, k: Key): Action | undefined {
	return BINDINGS[mode].find((b) => b.match(k))?.action;
}

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

/** Footer hint per mode. */
export function footerHint(mode: Mode): string {
	switch (mode) {
		case "list":
			return "↑↓ select · enter interact · tab log · ? help · q quit";
		case "log":
			return "↑↓ scroll · pgup/pgdn page · g/G top/bottom · tab back · q quit";
		case "interact":
			return "esc back · every other key goes to Metro";
		case "help":
			return "esc close · ctrl-c quit";
	}
}
