import { describe, expect, test } from "bun:test";
import { cellFrames, cellNumber, cellPid, cellText, createRowParser, parseRows } from "./xml-rows";

const XML = `<?xml version="1.0"?>
<trace-query-result>
<node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
<schema name="time-profile"><col><mnemonic>time</mnemonic><name>Sample Time</name></col><col><mnemonic>thread</mnemonic></col><col><mnemonic>weight</mnemonic></col><col><mnemonic>stack</mnemonic></col></schema>
<row><sample-time id="1" fmt="00:00.010">10000000</sample-time><thread id="2" fmt="Main Thread 0x1 (ShopApp, pid: 4242)"><tid id="3" fmt="0x1">1</tid><process id="4" fmt="ShopApp (4242)"><pid id="5" fmt="4242">4242</pid></process></thread><weight id="6" fmt="1.00 ms">1000000</weight><backtrace id="7"><frame id="8" name="leaf &amp; co" addr="0x10"><binary id="9" name="ShopApp" path="/a/ShopApp.app/ShopApp"/></frame><frame id="10" name="main" addr="0x20"><binary ref="9"/></frame></backtrace></row>
<row><sample-time id="11" fmt="00:00.011">11000000</sample-time><thread ref="2"/><weight ref="6"/><backtrace id="12"><frame ref="8"/><frame id="13" name="other" addr="0x30"><binary id="14" name="UIKitCore" path="/System/Library/UIKitCore"/></frame></backtrace></row>
<row><sample-time id="15" fmt="00:00.012">12000000</sample-time><thread ref="2"/><weight ref="6"/><sentinel/></row>
</node>
</trace-query-result>`;

describe("parseRows", () => {
	test("resolves id/ref for threads, processes, frames and binaries", () => {
		const rows = parseRows(XML);
		expect(rows).toHaveLength(3);
		expect(rows[0]?.schema).toBe("time-profile");
		expect(rows[0]?.columns).toEqual(["time", "thread", "weight", "stack"]);
		const [r0, r1, r2] = rows;
		expect(cellNumber(r0?.cells[0])).toBe(10_000_000);
		expect(cellText(r1?.cells[1])).toContain("Main Thread");
		expect(cellPid(r1?.cells[1])).toBe(4242);
		expect(cellNumber(r1?.cells[2])).toBe(1_000_000);
		expect(cellFrames(r0?.cells[3])).toEqual([
			{ name: "leaf & co", binary: "/a/ShopApp.app/ShopApp" },
			{ name: "main", binary: "/a/ShopApp.app/ShopApp" },
		]);
		expect(cellFrames(r1?.cells[3])).toEqual([
			{ name: "leaf & co", binary: "/a/ShopApp.app/ShopApp" },
			{ name: "other", binary: "/System/Library/UIKitCore" },
		]);
		expect(cellFrames(r2?.cells[3])).toEqual([]);
		expect(r2?.cells[3]?.tag).toBe("sentinel");
	});

	test("chunk boundaries anywhere give the same rows", () => {
		const whole = parseRows(XML).map((r) => r.cells.map(cellText));
		for (const size of [1, 7, 64]) {
			const rows: string[][] = [];
			const p = createRowParser({
				onSchema: () => undefined,
				onRow: (cells) => rows.push(cells.map(cellText)),
			});
			for (let i = 0; i < XML.length; i += size) p.feed(XML.slice(i, i + size));
			p.end();
			expect(rows).toEqual(whole);
		}
	});

	test("several tables in one export keep their own columns", () => {
		const xml = `<node><schema name="a"><col><mnemonic>x</mnemonic></col></schema><row><v fmt="1">1</v></row></node>
<node><schema name="b"><col><mnemonic>y</mnemonic></col><col><mnemonic>z</mnemonic></col></schema><row><v fmt="2">2</v><v fmt="3">3</v></row></node>`;
		const rows = parseRows(xml);
		expect(rows.map((r) => [r.schema, r.columns])).toEqual([
			["a", ["x"]],
			["b", ["y", "z"]],
		]);
	});
});
