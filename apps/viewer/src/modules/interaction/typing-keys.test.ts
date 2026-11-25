import { describe, expect, test } from "bun:test";
import { classifyTypingKey, TYPING_BUFFER_MS } from "./typing-keys.ts";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
	key: k,
	ctrlKey: false,
	metaKey: false,
	altKey: false,
	...mods,
});

describe("classifyTypingKey", () => {
	test("buffer is 25 ms", () => {
		expect(TYPING_BUFFER_MS).toBe(25);
	});
	test("printable characters are text", () => {
		expect(classifyTypingKey(key("a"))).toEqual({ kind: "text", text: "a" });
		expect(classifyTypingKey(key("A"))).toEqual({ kind: "text", text: "A" });
		expect(classifyTypingKey(key(" "))).toEqual({ kind: "text", text: " " });
	});
	test("Backspace and Enter are device keys", () => {
		expect(classifyTypingKey(key("Backspace"))).toEqual({ kind: "key", key: "BACKSPACE" });
		expect(classifyTypingKey(key("Enter"))).toEqual({ kind: "key", key: "ENTER" });
	});
	test("Cmd or Ctrl+V is paste, either case", () => {
		expect(classifyTypingKey(key("v", { metaKey: true }))).toEqual({ kind: "paste" });
		expect(classifyTypingKey(key("V", { ctrlKey: true }))).toEqual({ kind: "paste" });
	});
	test("Escape exits typing mode", () => {
		expect(classifyTypingKey(key("Escape"))).toEqual({ kind: "exit" });
	});
	test("other chords and named keys are ignored", () => {
		expect(classifyTypingKey(key("c", { metaKey: true }))).toBeNull();
		expect(classifyTypingKey(key("a", { ctrlKey: true }))).toBeNull();
		expect(classifyTypingKey(key("a", { altKey: true }))).toBeNull();
		expect(classifyTypingKey(key("ArrowUp"))).toBeNull();
		expect(classifyTypingKey(key("Shift"))).toBeNull();
	});
});
