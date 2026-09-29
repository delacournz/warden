export type Version = { major: number; minor: number; patch: number; pre: string[] };

/** `1.2.3`, `v1.2.3`, `1.0.0-rc.2` → parts; anything else → undefined. */
export function parseVersion(input: string): Version | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(input.trim());
	if (!match) return undefined;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		pre: match[4] ? match[4].split(".") : [],
	};
}

/** One prerelease identifier: numeric < alphanumeric, numerics by value. */
function compareIdent(x: string, y: string): number {
	const xn = /^\d+$/.test(x);
	const yn = /^\d+$/.test(y);
	if (xn && yn) return Number(x) - Number(y);
	if (xn !== yn) return xn ? -1 : 1;
	return x === y ? 0 : x < y ? -1 : 1;
}

/** No prerelease sorts after any prerelease; otherwise identifier by identifier, shorter first. */
function comparePre(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return b.length - a.length;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		const diff = compareIdent(a[i] ?? "", b[i] ?? "");
		if (diff !== 0) return diff;
	}
	return a.length - b.length;
}

/** Semver order; unparseable versions sort lowest. */
export function compareVersions(a: string, b: string): number {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
	return x.major - y.major || x.minor - y.minor || x.patch - y.patch || comparePre(x.pre, y.pre);
}
