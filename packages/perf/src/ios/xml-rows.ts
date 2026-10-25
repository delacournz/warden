/**
 * Streaming parser for `xctrace export --xpath …` table output.
 *
 * An export is one `<schema>` (the column mnemonics) followed by `<row>`s whose cells are positional. To keep
 * the file small, a cell that repeats an earlier one is written as `<tag ref="N"/>` and the first occurrence
 * carries `id="N"` (threads, processes, frames, binaries, whole backtraces). The parser resolves those on the fly,
 * so a row handler sees complete cells. Input arrives in chunks and is cut only at `</row>` / `</schema>`, so
 * memory stays bounded by the id table, not by the file.
 */

export type XmlNode = {
	tag: string;
	attrs: Readonly<Record<string, string>>;
	text: string;
	kids: XmlNode[];
};

/** Tags whose children matter to the analysis; every other cell is a leaf (`fmt` + text). */
const STRUCTURAL = new Set(["thread", "process", "backtrace", "tagged-backtrace", "frame", "binary", "text-addresses"]);

const TOKEN =
	/<(\/)?([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/)?>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|([^<]+)/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(ENTITY, (_all, name: string) => {
		const named = NAMED[name];
		if (named !== undefined) return named;
		const code = name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
		return Number.isFinite(code) ? String.fromCodePoint(code) : _all;
	});
}

function parseAttrs(raw: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	if (raw.trim() === "") return attrs;
	ATTR.lastIndex = 0;
	for (let m = ATTR.exec(raw); m !== null; m = ATTR.exec(raw)) {
		const name = m[1];
		if (name !== undefined) attrs[name] = decode(m[2] ?? m[3] ?? "");
	}
	return attrs;
}

export type RowParserHandlers = {
	/** a `<schema name=…>` ended: its column mnemonics in cell order */
	onSchema: (name: string, columns: string[]) => void;
	/** one complete row of the latest schema, refs resolved */
	onRow: (cells: XmlNode[], schema: string, columns: string[]) => void;
};

export type RowParser = {
	feed: (chunk: string) => void;
	/** flush the tail; call once after the last chunk */
	end: () => void;
};

type Open = { node: XmlNode; inRow: boolean };

/** Push parser: `feed` chunks of an export, `end`, and the handlers run as schemas and rows complete. */
export function createRowParser(handlers: RowParserHandlers): RowParser {
	const defs = new Map<string, XmlNode>();
	const stack: Open[] = [];
	let schemaName = "";
	let columns: string[] = [];
	let collecting: string[] | undefined;
	let cells: XmlNode[] | undefined;
	let carry = "";

	function closeNode(open: Open): void {
		const { node } = open;
		let resolved = node;
		const ref = node.attrs.ref;
		if (ref !== undefined) resolved = defs.get(`${node.tag}:${ref}`) ?? node;
		else {
			const id = node.attrs.id;
			if (id !== undefined) defs.set(`${node.tag}:${id}`, node);
		}
		const parent = stack[stack.length - 1];
		if (cells !== undefined && stack[stack.length - 1]?.node.tag === "row") cells.push(resolved);
		else if (open.inRow && parent !== undefined && STRUCTURAL.has(parent.node.tag)) parent.node.kids.push(resolved);
		if (!STRUCTURAL.has(node.tag)) node.kids.length = 0;
	}

	/** Character data: mnemonic names while reading a schema, node text inside a row. */
	function onText(text: string): void {
		const top = stack[stack.length - 1];
		if (top === undefined) return;
		if (collecting !== undefined && top.node.tag === "mnemonic") collecting.push(text.trim());
		else if (top.inRow && !STRUCTURAL.has(top.node.tag)) top.node.text += decode(text);
	}

	/** A closing tag: finish the row or schema, else the node. */
	function onClose(tag: string): void {
		const open = stack.pop();
		if (open === undefined) return;
		if (tag === "row") {
			if (cells !== undefined) handlers.onRow(cells, schemaName, columns);
			cells = undefined;
		} else if (tag === "schema") {
			columns = collecting ?? [];
			collecting = undefined;
			handlers.onSchema(schemaName, columns);
		} else closeNode(open);
	}

	/** An opening `<row>`; a self-closing one is an empty row. */
	function openRow(attrs: Record<string, string>, selfClosing: boolean): void {
		cells = [];
		if (!selfClosing) {
			stack.push({ node: { tag: "row", attrs, text: "", kids: [] }, inRow: true });
			return;
		}
		handlers.onRow([], schemaName, columns);
		cells = undefined;
	}

	/** An opening `<schema>`; a self-closing one has no columns. */
	function openSchema(attrs: Record<string, string>, selfClosing: boolean): void {
		schemaName = attrs.name ?? "";
		collecting = [];
		if (!selfClosing) {
			stack.push({ node: { tag: "schema", attrs, text: "", kids: [] }, inRow: false });
			return;
		}
		columns = [];
		collecting = undefined;
		handlers.onSchema(schemaName, columns);
	}

	/** Any other opening tag: a node, closed at once when self-closing. */
	function openNode(tag: string, attrs: Record<string, string>, selfClosing: boolean): void {
		const top = stack[stack.length - 1];
		const inRow = cells !== undefined;
		const node: XmlNode = { tag, attrs, text: "", kids: [] };
		if (selfClosing) closeNode({ node, inRow });
		else stack.push({ node, inRow: inRow && (top === undefined || top.inRow) });
	}

	/** An opening tag, dispatched on its name. */
	function onOpen(tag: string, attrs: Record<string, string>, selfClosing: boolean): void {
		if (tag === "row") openRow(attrs, selfClosing);
		else if (tag === "schema") openSchema(attrs, selfClosing);
		else openNode(tag, attrs, selfClosing);
	}

	function consume(piece: string): void {
		TOKEN.lastIndex = 0;
		for (let m = TOKEN.exec(piece); m !== null; m = TOKEN.exec(piece)) {
			const text = m[5];
			if (text !== undefined) {
				onText(text);
				continue;
			}
			const tag = m[2];
			if (tag === undefined) continue;
			if (m[1] === "/") onClose(tag);
			else onOpen(tag, parseAttrs(m[3] ?? ""), m[4] === "/");
		}
	}

	return {
		feed(chunk) {
			carry += chunk;
			const row = carry.lastIndexOf("</row>");
			const schema = carry.lastIndexOf("</schema>");
			const cut = Math.max(row === -1 ? -1 : row + 6, schema === -1 ? -1 : schema + 9);
			if (cut === -1) return;
			const piece = carry.slice(0, cut);
			carry = carry.slice(cut);
			consume(piece);
		},
		end() {
			if (carry !== "") consume(carry);
			carry = "";
		},
	};
}

/** Parse a whole export held in memory (small tables, tests). */
export function parseRows(xml: string): Array<{ schema: string; columns: string[]; cells: XmlNode[] }> {
	const rows: Array<{ schema: string; columns: string[]; cells: XmlNode[] }> = [];
	const parser = createRowParser({
		onSchema: () => undefined,
		onRow: (cells, schema, columns) => rows.push({ schema, columns, cells }),
	});
	parser.feed(xml);
	parser.end();
	return rows;
}

/** `fmt` when the cell has one (the human form), else its text. */
export function cellText(cell: XmlNode | undefined): string {
	if (cell === undefined) return "";
	return cell.attrs.fmt ?? cell.text.trim();
}

/** The numeric value of a cell (`text`, in the instrument's raw unit: ns for times and durations, bytes for sizes). */
export function cellNumber(cell: XmlNode | undefined): number | undefined {
	if (cell === undefined) return undefined;
	const n = Number(cell.text.trim());
	return cell.text.trim() === "" || !Number.isFinite(n) ? undefined : n;
}

export type StackFrame = { name: string; binary: string };

/** The frames of a backtrace cell, innermost first. Nested wrappers (`tagged-backtrace`) are looked through. */
export function cellFrames(cell: XmlNode | undefined): StackFrame[] {
	const frames: StackFrame[] = [];
	const walk = (node: XmlNode): void => {
		if (node.tag === "frame") {
			const bin = node.kids.find((k) => k.tag === "binary");
			frames.push({
				name: node.attrs.name ?? node.attrs.addr ?? "?",
				binary: bin?.attrs.path ?? bin?.attrs.name ?? "",
			});
			return;
		}
		for (const kid of node.kids) walk(kid);
	};
	if (cell !== undefined) walk(cell);
	return frames;
}

/** pid of a `process` / `thread` cell: the `pid` child, else `(123)` / `pid: 123` in its `fmt`. */
export function cellPid(cell: XmlNode | undefined): number | undefined {
	if (cell === undefined) return undefined;
	const find = (node: XmlNode): number | undefined => {
		if (node.tag === "pid") {
			const n = Number(node.text.trim());
			if (Number.isFinite(n) && node.text.trim() !== "") return n;
		}
		for (const kid of node.kids) {
			const found = find(kid);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	const direct = find(cell);
	if (direct !== undefined) return direct;
	const m = /(?:pid:\s*|\()(\d+)\)?/.exec(cell.attrs.fmt ?? "");
	return m?.[1] === undefined ? undefined : Number(m[1]);
}
