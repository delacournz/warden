import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Platform } from "../types";

/** Stream one file into `hash`; false when it cannot be read. */
function feed(hash: ReturnType<typeof createHash>, path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", () => resolve(false));
		stream.on("end", () => resolve(true));
	});
}

/** Stream `files` (in order, each prefixed with its label) into one sha256. */
async function digest(files: readonly { label: string; path: string }[]): Promise<string | undefined> {
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(`${file.label}\0`);
		if (!(await feed(hash, file.path))) return undefined;
	}
	return `sha256:${hash.digest("hex")}`;
}

/** The files of an `.app` that make one base differ from another: Info.plist, the code signature, the executable(s). */
function iosIdentityFiles(app: string): { label: string; path: string }[] | undefined {
	try {
		const own = basename(app, ".app");
		const executables = readdirSync(app)
			.filter((name) => {
				const st = statSync(join(app, name));
				return st.isFile() && (name === own || (st.mode & 0o111) !== 0);
			})
			.sort();
		const files = [
			{ label: "Info.plist", path: join(app, "Info.plist") },
			{ label: "CodeResources", path: join(app, "_CodeSignature", "CodeResources") },
			...executables.map((name) => ({ label: `exe:${name}`, path: join(app, name) })),
		];
		return files.filter((f) => {
			try {
				return statSync(f.path).isFile();
			} catch {
				return false;
			}
		});
	} catch {
		return undefined;
	}
}

/**
 * What a simulator base is, as a short hash: a repack is only valid over the exact base it was cloned from, and a
 * base can be replaced under the same native fingerprint (`warden builds import`, another signer, other entitlements).
 * iOS: the executable (the code signature and entitlements are embedded in the Mach-O), `Info.plist` and
 * `_CodeSignature/CodeResources` (which hashes every resource), not the whole `.app`. Android: the apk (one file).
 * Undefined when the base cannot be read.
 */
export async function baseIdentity(platform: Platform, artifact: string): Promise<string | undefined> {
	if (platform === "android") return digest([{ label: "apk", path: artifact }]);
	const files = iosIdentityFiles(artifact);
	if (!files || files.length === 0) return undefined;
	return digest(files);
}
