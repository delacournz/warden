export type DwarfUuid = { uuid: string; arch: string; path: string };

/** `UUID: 5F6A1C2E-… (arm64) /path/App.app.dSYM/Contents/Resources/DWARF/App` (one line per slice). */
export function parseDwarfdumpUuid(text: string): DwarfUuid[] {
	return text.split("\n").flatMap((line) => {
		const m = /^UUID:\s+([0-9A-Fa-f-]{36})\s+\(([^)]+)\)\s+(.+)$/.exec(line.trim());
		return m?.[1] && m[2] && m[3] ? [{ uuid: m[1].toLowerCase(), arch: m[2], path: m[3] }] : [];
	});
}

const hex = (n: number): string => `0x${n.toString(16)}`;

/** `atos -arch <arch> -o <dwarf binary> -l <load address> <addresses…>`. */
export function atosArgv(binary: string, arch: string, loadAddress: number, addresses: readonly number[]): string[] {
	return ["atos", "-arch", arch, "-o", binary, "-l", hex(loadAddress), ...addresses.map(hex)];
}

/** `atos` prints one line per address; an address it cannot resolve comes back as the bare `0x…` (→ undefined). */
export function parseAtos(text: string, count: number): Array<string | undefined> {
	const lines = text.split("\n").filter((l) => l.trim() !== "");
	return Array.from({ length: count }, (_, i) => {
		const line = lines[i]?.trim();
		return line === undefined || /^0x[0-9a-f]+$/i.test(line) ? undefined : line;
	});
}
