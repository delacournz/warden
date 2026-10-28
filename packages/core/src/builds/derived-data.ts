import { readFileSync } from "node:fs";
import { join } from "node:path";

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Xcode records the workspace a DerivedData dir belongs to in its `info.plist` (`WorkspacePath`). */
export function derivedDataWorkspace(projectDir: string): string | undefined {
	try {
		const plist = readFileSync(join(projectDir, "info.plist"), "utf8");
		const raw = /<key>WorkspacePath<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
		return raw?.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name] ?? "");
	} catch {
		return undefined;
	}
}
