// Spike: run xterm-pane.ts in a Bun PTY, replay its output through a second xterm, compare cells.
import { Terminal } from "@xterm/headless";
import { feed, makePane, serializeRow } from "./xterm-pane";

const OW = 100;
const OH = 60;
const fixture = new Uint8Array(
	await Bun.file(`${import.meta.dir}/../../src/dev-tui/fixtures/expo-start.bin`).arrayBuffer()
);

const SER = process.env.PANE_SER ?? "own";
async function runPane(tall: boolean) {
	const chunks: Uint8Array[] = [];
	const proc = Bun.spawn(["bun", `${import.meta.dir}/xterm-pane.ts`], {
		env: { ...process.env, PANE_TALL: tall ? "1" : "0", PANE_SER: SER },
		terminal: { cols: OW, rows: OH, data: (_t, c) => chunks.push(new Uint8Array(c)) },
	});
	await proc.exited;
	const all = Buffer.concat(chunks);
	// split at the stage markers (OSC 0 titles) so each stage can be inspected
	const text = all.toString("latin1");
	const s1 = text.indexOf("\x1b]0;stage1\x07");
	const s2 = text.indexOf("\x1b]0;stage2\x07");
	return [all.subarray(0, s1), all.subarray(0, s2)] as const;
}

function cellKey(line: ReturnType<Terminal["buffer"]["active"]["getLine"]>, x: number) {
	const c = line?.getCell(x);
	if (!c) return "";
	return [
		c.getChars() || " ",
		c.getFgColorMode(),
		c.getFgColor(),
		c.getBgColorMode(),
		c.getBgColor(),
		c.isBold(),
		c.isDim(),
		c.isUnderline(),
		c.isItalic(),
	].join("|");
}

async function check(tall: boolean) {
	const [stage1, stage2] = await runPane(tall);
	const rowsN = tall ? 50 : 20;
	const results: Record<string, unknown> = { tall };
	for (const [name, bytes, cols, rows] of [
		["stage1 60x" + rowsN, stage1, 60, rowsN],
		["stage2 70x" + (tall ? 50 : 24), stage2, 70, tall ? 50 : 24],
	] as const) {
		const outer = new Terminal({ cols: OW, rows: OH, allowProposedApi: true });
		await feed(outer, bytes);
		const ob = outer.buffer.active;
		// expected source: rebuild the inner terminal the same way the script did
		const src = makePane(60, rowsN);
		await feed(src.term, fixture);
		if (cols === 70) {
			src.term.resize(70, rows);
			await feed(src.term, fixture.slice(fixture.length - 1500));
		}
		const sb = src.term.buffer.active;
		let mismatches = 0;
		let colouredCells = 0;
		for (let y = 0; y < rows; y++) {
			for (let x = 0; x < cols; x++) {
				const a = cellKey(sb.getLine(sb.baseY + y), x);
				const b = cellKey(ob.getLine(4 + y), 8 + 1 + x - 1 + 0); // box col ox=8 (1-based) -> 0-based 7, inner starts at 8
				if (a !== b) {
					mismatches++;
					if (mismatches < 4) console.log("  mismatch", name, y, x, JSON.stringify(a), JSON.stringify(b));
				}
				if (
					sb
						.getLine(sb.baseY + y)
						?.getCell(x)
						?.getFgColorMode()
				)
					colouredCells++;
			}
		}
		// bleed: everything outside the box rectangle (rows oy-1..oy+rows, cols ox-1..ox+cols) must be filler
		let bleed = 0;
		const top = 3; // 0-based row of top border
		const left = 7; // 0-based col of left border
		for (let y = 0; y < OH; y++) {
			const line = ob.getLine(y);
			for (let x = 0; x < OW; x++) {
				const inside = y >= top && y <= top + rows + 1 && x >= left && x <= left + cols + 1;
				if (inside) continue;
				if (line?.getCell(x)?.getChars() !== "·") bleed++;
			}
		}
		// border integrity
		let border = 0;
		for (let y = 0; y < rows; y++) {
			const line = ob.getLine(top + 1 + y);
			if (line?.getCell(left)?.getChars() !== "│" || line?.getCell(left + cols + 1)?.getChars() !== "│") border++;
		}
		const cursor = {
			outer: [ob.cursorX, ob.cursorY],
			expected: [left + 1 + sb.cursorX, top + 1 + sb.cursorY],
			inner: [sb.cursorX, sb.cursorY],
		};
		results[name] = { mismatches, colouredCells, bleed, brokenBorders: border, cursor };
		if (name.startsWith("stage1") && tall) {
			console.log("--- stage1 tall text rows (outer rows 3..14) ---");
			for (let y = 3; y < 15; y++) console.log(ob.getLine(y)?.translateToString(true));
		}
	}
	console.log(JSON.stringify(results));
}

await check(false);
await check(true);

// timing: whole transcript write + serialize
for (const reps of [1, 100]) {
	const p = makePane(60, 20);
	const data = reps === 1 ? fixture : Buffer.concat(Array.from({ length: reps }, () => fixture));
	const t0 = performance.now();
	await feed(p.term, data);
	const t1 = performance.now();
	const full = p.ser.serialize();
	const t2 = performance.now();
	const b = p.term.buffer.active;
	const t3 = performance.now();
	for (let i = 0; i < 20; i++)
		for (let y = 0; y < 20; y++) p.ser.serialize({ range: { start: b.baseY + y, end: b.baseY + y } });
	const t4 = performance.now();
	const t5 = performance.now();
	for (let i = 0; i < 20; i++) for (let y = 0; y < 20; y++) serializeRow(b.getLine(b.baseY + y) as never, 60);
	const t6 = performance.now();
	console.log(
		JSON.stringify({
			reps,
			ownViewport20RowsMs: +((t6 - t5) / 20).toFixed(3),
			bytes: data.length,
			writeMs: +(t1 - t0).toFixed(2),
			serializeAllMs: +(t2 - t1).toFixed(2),
			serializedChars: full.length,
			viewport20RowsMs: +((t4 - t3) / 20).toFixed(3),
			scrollbackLines: b.baseY,
		})
	);
}
