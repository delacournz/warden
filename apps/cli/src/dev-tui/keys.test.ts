import { describe, expect, test } from "bun:test";
import { actionFor, createKeyParser, ESC_TIMEOUT_MS, EXPO_KEYS, type Key, type KeyTimers, LIST_BINDINGS } from "./keys";

function fakeTimers() {
	const pending: Array<{ fn: () => void; ms: number; live: boolean }> = [];
	const timers: KeyTimers = {
		set: (fn, ms) => {
			const entry = { fn, ms, live: true };
			pending.push(entry);
			return entry;
		},
		clear: (handle) => {
			(handle as { live: boolean }).live = false;
		},
	};
	return {
		timers,
		fire: () => {
			for (const entry of pending.splice(0)) if (entry.live) entry.fn();
		},
		count: () => pending.filter((e) => e.live).length,
	};
}

function parse(...chunks: Array<string | Uint8Array>) {
	const keys: Key[] = [];
	const clock = fakeTimers();
	const parser = createKeyParser((k) => keys.push(k), clock.timers);
	for (const chunk of chunks) parser.feed(chunk);
	return { keys, clock };
}

describe("createKeyParser", () => {
	test("printable keys; capitals carry shift", () => {
		const { keys } = parse("qR?");
		expect(keys.map((k) => [k.name, k.shift])).toEqual([
			["q", false],
			["R", true],
			["?", false],
		]);
	});

	test("ctrl keys", () => {
		const { keys } = parse("\x03\x0c");
		expect(keys.map((k) => [k.name, k.ctrl])).toEqual([
			["c", true],
			["l", true],
		]);
	});

	test("enter, tab, backspace", () => {
		const { keys } = parse("\r\t\x7f");
		expect(keys.map((k) => k.name)).toEqual(["enter", "tab", "backspace"]);
	});

	test("arrows, home/end, pgup/pgdn, shift-tab", () => {
		const { keys } = parse("\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F\x1b[5~\x1b[6~\x1b[Z\x1bOA");
		expect(keys.map((k) => k.name)).toEqual([
			"up",
			"down",
			"right",
			"left",
			"home",
			"end",
			"pgup",
			"pgdn",
			"tab",
			"up",
		]);
		expect(keys[8]?.shift).toBe(true);
	});

	test("a lone Esc becomes escape after the timeout", () => {
		const { keys, clock } = parse("\x1b");
		expect(keys).toEqual([]);
		expect(clock.count()).toBe(1);
		clock.fire();
		expect(keys.map((k) => k.name)).toEqual(["escape"]);
		expect(ESC_TIMEOUT_MS).toBeLessThan(100);
	});

	test("Esc followed by [A in a later chunk is one arrow, no escape", () => {
		const { keys, clock } = parse("\x1b", "[A");
		clock.fire();
		expect(keys.map((k) => k.name)).toEqual(["up"]);
	});

	test("Esc then a printable key is escape + the key", () => {
		const { keys } = parse("\x1bq");
		expect(keys.map((k) => k.name)).toEqual(["escape", "q"]);
	});

	test("a UTF-8 character split across chunks decodes once", () => {
		const bytes = new TextEncoder().encode("é");
		const { keys } = parse(bytes.slice(0, 1), bytes.slice(1));
		expect(keys.map((k) => k.name)).toEqual(["é"]);
	});

	test("seq keeps the raw bytes", () => {
		const { keys } = parse("\x1b[5~");
		expect(keys[0]?.seq).toBe("\x1b[5~");
	});
});

const press = (name: string, flags: Partial<Key> = {}): Key => ({
	name,
	ctrl: false,
	shift: false,
	seq: name,
	...flags,
});

describe("actionFor", () => {
	test("list mode moves the selection with arrows and j/k", () => {
		expect(actionFor("list", press("down"))).toEqual({ type: "select", delta: 1 });
		expect(actionFor("list", press("j"))).toEqual({ type: "select", delta: 1 });
		expect(actionFor("list", press("up"))).toEqual({ type: "select", delta: -1 });
		expect(actionFor("list", press("k"))).toEqual({ type: "select", delta: -1 });
	});

	test("q and Ctrl-C quit; ? opens help; tab focuses the log", () => {
		expect(actionFor("list", press("q"))).toEqual({ type: "quit" });
		expect(actionFor("list", press("c", { ctrl: true }))).toEqual({ type: "quit" });
		expect(actionFor("list", press("?"))).toEqual({ type: "mode", mode: "help" });
		expect(actionFor("list", press("tab"))).toEqual({ type: "mode", mode: "log" });
	});

	test("every action key in the plan's map is bound, built or not", () => {
		for (const name of ["r", "d", "o", "s", "R", "x", "c", "l", "p", "P", "m", "f", "g"]) {
			expect(actionFor("list", press(name))?.type).toBe("unavailable");
		}
		expect(actionFor("list", press("h"))).toEqual({ type: "hud" });
		expect(actionFor("list", press("l", { ctrl: true }))).toEqual({ type: "redraw" });
	});

	test("enter and i interact with Metro", () => {
		for (const name of ["enter", "i"]) expect(actionFor("list", press(name))).toEqual({ type: "interact" });
	});

	test("interact mode: Esc leaves, Shift+PgUp/PgDn scroll the pane, everything else goes to Expo", () => {
		expect(actionFor("interact", press("escape"))).toEqual({ type: "mode", mode: "list" });
		expect(actionFor("interact", press("pgup", { shift: true }))).toEqual({ type: "pane-scroll", dir: 1 });
		expect(actionFor("interact", press("pgdn", { shift: true }))).toEqual({ type: "pane-scroll", dir: -1 });
		for (const k of [
			press("r"),
			press("?"),
			press("up"),
			press("c", { ctrl: true }),
			press("q"),
			press("pgup"),
			press("l", { ctrl: true }),
		])
			expect(actionFor("interact", k)).toEqual({ type: "forward" });
	});

	test("plain letters do not fire on Ctrl", () => {
		expect(actionFor("list", press("r", { ctrl: true }))).toBeUndefined();
	});

	test("log mode scrolls; g and G jump", () => {
		expect(actionFor("log", press("up"))).toEqual({ type: "scroll", kind: "line", dir: 1 });
		expect(actionFor("log", press("pgdn"))).toEqual({ type: "scroll", kind: "page", dir: -1 });
		expect(actionFor("log", press("g"))).toEqual({ type: "scroll", kind: "top", dir: 1 });
		expect(actionFor("log", press("G", { shift: true }))).toEqual({ type: "scroll", kind: "bottom", dir: -1 });
		expect(actionFor("log", press("escape"))).toEqual({ type: "mode", mode: "list" });
	});

	test("help closes on Esc, ?, q; Ctrl-C still quits", () => {
		for (const name of ["escape", "?", "q"])
			expect(actionFor("help", press(name))).toEqual({ type: "mode", mode: "list" });
		expect(actionFor("help", press("c", { ctrl: true }))).toEqual({ type: "quit" });
		expect(actionFor("help", press("j"))).toBeUndefined();
	});
});

describe("Shift+PgUp / PgDn", () => {
	test("the parser marks a modified ~ sequence shift", () => {
		const { keys } = parse("\x1b[5;2~", "\x1b[6;2~", "\x1b[5~");
		expect(keys.map((k) => [k.name, k.shift])).toEqual([
			["pgup", true],
			["pgdn", true],
			["pgup", false],
		]);
	});
});

describe("help text sources", () => {
	test("the key map lists warden's keys and Expo's", () => {
		const labels = LIST_BINDINGS.filter((b) => !b.hidden).map((b) => b.label);
		expect(labels).toContain("q ctrl-c");
		expect(labels).toContain("?");
		expect(EXPO_KEYS.map((k) => k.label)).toEqual(["a", "i", "w", "j", "r", "m", "shift+m", "o", "?"]);
	});
});
