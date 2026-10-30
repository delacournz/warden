import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A short content hash for every card under `dir` (`public/og`), keyed by its public path
 * (`/og/default.png`). The build bakes it into `og:image` as `?v=`: X, Slack and LinkedIn cache a
 * card by its URL, so a redrawn card under the same URL keeps showing the old one.
 */
export function ogVersions(dir: string): Record<string, string> {
	if (!existsSync(dir)) return {};

	const versions: Record<string, string> = {};
	for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
		if (!file.endsWith(".png")) continue;
		const hash = createHash("sha256")
			.update(readFileSync(join(dir, file)))
			.digest("hex");
		versions[`/og/${file.split("\\").join("/")}`] = hash.slice(0, 10);
	}
	return versions;
}
