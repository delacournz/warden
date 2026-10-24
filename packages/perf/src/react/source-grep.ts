/** `Memo(Foo)` / `ForwardRef(Foo)` / `Foo` → `Foo`; anything that is not a plain identifier → undefined. */
export function declarationName(displayName: string): string | undefined {
	let name = displayName;
	for (let i = 0; i < 4; i++) {
		const wrapped = /^[A-Za-z]+\((.+)\)$/.exec(name);
		if (wrapped?.[1] === undefined) break;
		name = wrapped[1];
	}
	return /^[A-Za-z_$][\w$]*$/.test(name) ? name : undefined;
}

/**
 * 1-based line where `name` is declared in `text`: `function Name`, `class Name`, `const|let|var Name =`
 * (also `export` / `export default` forms). Undefined when it is not.
 */
export function findDeclaration(text: string, name: string): number | undefined {
	const id = name.replace(/[$]/g, "\\$");
	const pattern = new RegExp(
		`(?:^|[^\\w$.])(?:function\\s*\\*?\\s+${id}(?![\\w$])|class\\s+${id}(?![\\w$])|(?:const|let|var)\\s+${id}(?![\\w$])\\s*(?::[^=\\n]+)?=)`
	);
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (pattern.test(lines[i] ?? "")) return i + 1;
	}
	return undefined;
}
