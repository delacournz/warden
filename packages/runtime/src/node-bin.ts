import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export class NodeBin {
	/** `node_modules/.bin/<name>` nearest to `root` (hoisted monorepos put it at the repo root). */
	find(root: string, name: string, exists: (path: string) => boolean = existsSync): string | undefined {
		for (let dir = root; ; dir = dirname(dir)) {
			const bin = join(dir, "node_modules", ".bin", name);
			if (exists(bin)) return bin;
			if (dirname(dir) === dir) return undefined;
		}
	}
}

export const nodeBin = new NodeBin();
