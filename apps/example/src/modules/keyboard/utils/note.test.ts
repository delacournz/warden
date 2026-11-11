import { describe, expect, test } from "bun:test";
import { formatSavedNote, NO_NOTE, normalizeNote } from "./note";

describe("note", () => {
	test("normalizeNote trims the draft", () => {
		expect(normalizeNote("  hello  ")).toBe("hello");
	});

	test("normalizeNote turns a blank draft into an empty note", () => {
		expect(normalizeNote("   ")).toBe("");
	});

	test("formatSavedNote shows none for an empty note", () => {
		expect(formatSavedNote("")).toBe(NO_NOTE);
	});

	test("formatSavedNote shows the note as is", () => {
		expect(formatSavedNote("buy milk")).toBe("buy milk");
	});
});
