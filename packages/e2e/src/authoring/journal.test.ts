import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalStore } from "./journal";
import { type Recording, recordingSchema } from "./recording.schema";

const header: Pick<Recording, "name" | "createdAt" | "recordedOn"> = {
	name: "sign in",
	createdAt: 1,
	recordedOn: { platform: "ios", device: "iPhone 16", screen: { width: 390, height: 844, scale: 3 } },
};

describe("journal", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "journal-"));
		file = join(dir, "recording.json");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("createJournal writes an empty valid recording; readJournal parses it", () => {
		const created = journalStore.createJournal(file, header);
		expect(created.success).toBe(true);
		const read = journalStore.readJournal(file);
		expect(read.success && read.data.steps).toEqual([]);
		expect(recordingSchema.safeParse(JSON.parse(readFileSync(file, "utf8"))).success).toBe(true);
	});

	test("createJournal refuses to overwrite", () => {
		journalStore.createJournal(file, header);
		const again = journalStore.createJournal(file, header);
		expect(again.success).toBe(false);
	});

	test("appends in order and numbers steps itself", async () => {
		journalStore.createJournal(file, header);
		const first = await journalStore.appendStep(file, { kind: "home", at: 10 });
		const second = await journalStore.appendStep(file, { kind: "back", at: 20, note: "go back" });
		expect(first.success && first.data.i).toBe(0);
		expect(second.success && second.data.i).toBe(1);
		const read = journalStore.readJournal(file);
		expect(read.success && read.data.steps.map((step) => step.kind)).toEqual(["home", "back"]);
	});

	test("a missing file is journal_missing and an invalid one journal_invalid", async () => {
		const missing = await journalStore.appendStep(join(dir, "nope.json"), { kind: "home", at: 1 });
		expect(!missing.success && missing.error.code).toBe("journal_missing");
		writeFileSync(file, '{"v":3}');
		const invalid = await journalStore.appendStep(file, { kind: "home", at: 1 });
		expect(!invalid.success && invalid.error.code).toBe("journal_invalid");
	});

	test("rewrites go through the injected write, whole-file", async () => {
		journalStore.createJournal(file, header);
		const writes: { path: string; text: string }[] = [];
		await journalStore.appendStep(
			file,
			{ kind: "home", at: 1 },
			{ write: (path, text) => void writes.push({ path, text }) }
		);
		expect(writes).toHaveLength(1);
		expect(writes[0]?.path).toBe(file);
		expect(recordingSchema.safeParse(JSON.parse(writes[0]?.text ?? "")).success).toBe(true);
	});

	test("leaves no lock or temp file behind", async () => {
		journalStore.createJournal(file, header);
		await journalStore.appendStep(file, { kind: "home", at: 1 });
		expect(readdirSync(dir)).toEqual(["recording.json"]);
	});

	test("a stale lock is broken", async () => {
		journalStore.createJournal(file, header);
		writeFileSync(`${file}.lock`, "999999");
		const result = await journalStore.appendStep(file, { kind: "home", at: 1 }, { staleMs: 0 });
		expect(result.success).toBe(true);
	});

	test("a held lock times out as lock_timeout", async () => {
		journalStore.createJournal(file, header);
		writeFileSync(`${file}.lock`, "1");
		const result = await journalStore.appendStep(file, { kind: "home", at: 1 }, { timeoutMs: 40, staleMs: 60_000 });
		expect(!result.success && result.error.code).toBe("lock_timeout");
	});

	test("concurrent appenders in one process never lose or reorder a step", async () => {
		journalStore.createJournal(file, header);
		const total = 25;
		const run = async (tag: string) => {
			const results = [];
			for (let n = 0; n < total; n += 1)
				results.push(
					await journalStore.appendStep(file, { kind: "screen", type: "screenshot", at: n, name: `${tag}-${n}` })
				);
			return results;
		};
		const [a, b] = await Promise.all([run("a"), run("b")]);
		expect([...a, ...b].every((result) => result.success)).toBe(true);
		const read = journalStore.readJournal(file);
		if (!read.success) throw new Error(read.error.message);
		expect(read.data.steps).toHaveLength(total * 2);
		expect(read.data.steps.map((step) => step.i)).toEqual(Array.from({ length: total * 2 }, (_, i) => i));
		for (const tag of ["a", "b"]) {
			const sequence = read.data.steps.flatMap((step) =>
				step.kind === "screen" && step.type === "screenshot" && step.name?.startsWith(`${tag}-`)
					? [Number(step.name.slice(2))]
					: []
			);
			expect(sequence).toEqual(Array.from({ length: total }, (_, n) => n));
		}
	});

	test("concurrent appenders in separate processes keep a contiguous order", async () => {
		journalStore.createJournal(file, header);
		const worker = join(import.meta.dir, "journal.worker.testing.ts");
		const total = 15;
		const spawn = (tag: string) =>
			Bun.spawn(["bun", worker, file, tag, String(total)], { stdout: "pipe", stderr: "pipe" });
		const [one, two] = [spawn("p"), spawn("q")];
		const codes = await Promise.all([one.exited, two.exited]);
		expect(codes).toEqual([0, 0]);
		const read = journalStore.readJournal(file);
		if (!read.success) throw new Error(read.error.message);
		expect(read.data.steps).toHaveLength(total * 2);
		expect(read.data.steps.map((step) => step.i)).toEqual(Array.from({ length: total * 2 }, (_, i) => i));
		expect(readdirSync(dir)).toEqual(["recording.json"]);
	});

	test("createJournalRecorder is the append seam: append(step) → numbered step", async () => {
		journalStore.createJournal(file, header);
		const recorder = journalStore.createJournalRecorder(file);
		const result = await recorder.append({ kind: "home", at: 5 });
		expect(result.success && result.data).toEqual({ kind: "home", at: 5, i: 0 });
	});

	test("a title in the header is kept", () => {
		journalStore.createJournal(file, { ...header, title: "Sign in with email" });
		const read = journalStore.readJournal(file);
		expect(read.success && read.data.title).toBe("Sign in with email");
	});

	test("undo drops the last step and returns it; renumbering stays contiguous", async () => {
		journalStore.createJournal(file, header);
		await journalStore.appendStep(file, { kind: "home", at: 1 });
		await journalStore.appendStep(file, { kind: "note", at: 2, text: "going back" });
		await journalStore.appendStep(file, { kind: "back", at: 3 });
		const undone = await journalStore.undoSteps(file);
		expect(undone.success && undone.data.map((step) => step.kind)).toEqual(["back"]);
		const next = await journalStore.appendStep(file, { kind: "reload", at: 4 });
		expect(next.success && next.data.i).toBe(2);
		const read = journalStore.readJournal(file);
		expect(read.success && read.data.steps.map((step) => step.kind)).toEqual(["home", "note", "reload"]);
	});

	test("undo n drops n steps oldest first in the result, and clamps to what there is", async () => {
		journalStore.createJournal(file, header);
		await journalStore.appendStep(file, { kind: "home", at: 1 });
		await journalStore.appendStep(file, { kind: "back", at: 2 });
		await journalStore.appendStep(file, { kind: "reload", at: 3 });
		const two = await journalStore.undoSteps(file, 2);
		expect(two.success && two.data.map((step) => step.kind)).toEqual(["back", "reload"]);
		const rest = await journalStore.undoSteps(file, 5);
		expect(rest.success && rest.data.map((step) => step.kind)).toEqual(["home"]);
	});

	test("undo on an empty recording is nothing_to_undo; a bad count is bad_count; a missing file is journal_missing", async () => {
		journalStore.createJournal(file, header);
		const empty = await journalStore.undoSteps(file);
		expect(!empty.success && empty.error.code).toBe("nothing_to_undo");
		await journalStore.appendStep(file, { kind: "home", at: 1 });
		const bad = await journalStore.undoSteps(file, 0);
		expect(!bad.success && bad.error.code).toBe("bad_count");
		const missing = await journalStore.undoSteps(join(dir, "nope.json"));
		expect(!missing.success && missing.error.code).toBe("journal_missing");
	});

	test("undo leaves no lock or temp file behind", async () => {
		journalStore.createJournal(file, header);
		await journalStore.appendStep(file, { kind: "home", at: 1 });
		await journalStore.undoSteps(file);
		expect(readdirSync(dir)).toEqual(["recording.json"]);
	});

	test("deleteJournal removes the file; a second delete is journal_missing", () => {
		journalStore.createJournal(file, header);
		expect(journalStore.deleteJournal(file).success).toBe(true);
		expect(readdirSync(dir)).toEqual([]);
		const again = journalStore.deleteJournal(file);
		expect(!again.success && again.error.code).toBe("journal_missing");
	});
});
