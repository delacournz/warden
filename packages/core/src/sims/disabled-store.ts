import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";

export const DEFAULT_DISABLED_STORE_ROOT = "/private/var/tmp";

const HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
`;
const FOOTER = "</dict>\n</plist>\n";

/** Directory holding `com.apple.CoreSimulator.SimDevice.<udid>/`; env override for tests. */
export function disabledStoreRoot(env: Record<string, string | undefined> = process.env): string {
	const override = env.WARDEN_SIM_LAUNCHD_STORE_ROOT;
	return override ? override : DEFAULT_DISABLED_STORE_ROOT;
}

export function disabledStorePath(udid: string, root: string = disabledStoreRoot()): string {
	return join(root, `com.apple.CoreSimulator.SimDevice.${udid}`, "disabled.plist");
}

const ENTITIES: Readonly<Record<string, string>> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
};

function decodeXml(s: string): string {
	return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m);
}

function encodeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** Flat `<key>label</key><true/|false/>` dict. Other value types and comments are skipped. */
export function parseDisabledStore(xml: string): Map<string, boolean> {
	const out = new Map<string, boolean>();
	const body = xml.replace(/<!--[\s\S]*?-->/g, "");
	const re =
		/<key>([\s\S]*?)<\/key>\s*(?:<(true|false)\s*\/>|<(?:string|integer|real|date|data)\b[^>]*>[\s\S]*?<\/(?:string|integer|real|date|data)>|<(?:string|data)\s*\/>|<(?:array|dict)\b[^>]*>[\s\S]*?<\/(?:array|dict)>)/g;
	for (const m of body.matchAll(re)) {
		const [, key, bool] = m;
		if (key === undefined || bool === undefined) continue;
		out.set(decodeXml(key), bool === "true");
	}
	return out;
}

export function encodeDisabledStore(entries: ReadonlyMap<string, boolean>): string {
	const keys = [...entries.keys()].sort();
	let body = "";
	for (const k of keys) {
		body += `\t<key>${encodeXml(k)}</key>\n\t<${entries.get(k) ? "true" : "false"}/>\n`;
	}
	return HEADER + body + FOOTER;
}

export function disabledLabels(entries: ReadonlyMap<string, boolean>): Set<string> {
	const out = new Set<string>();
	for (const [k, v] of entries) if (v) out.add(k);
	return out;
}

function isNotFound(e: unknown): boolean {
	return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
}

/** Missing file means nothing disabled (never booted). Corrupt or unreadable is an error. */
export async function readDisabledStore(
	udid: string,
	root: string = disabledStoreRoot()
): AsyncResult<Map<string, boolean>> {
	const path = disabledStorePath(udid, root);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (e) {
		if (isNotFound(e)) return ok(new Map());
		return err(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (!text.includes("<plist") || !text.includes("<dict>")) {
		return err(`corrupt disabled store ${path}: not a plist dict`);
	}
	return ok(parseDisabledStore(text));
}

/** Merge into the host-side store: disable → true, enable → false, everything else untouched. */
export async function writeDisabledStore(
	udid: string,
	changes: { disable: readonly string[]; enable: readonly string[] },
	root: string = disabledStoreRoot()
): AsyncResult<{ path: string; entries: number }> {
	const path = disabledStorePath(udid, root);
	const current = await readDisabledStore(udid, root);
	if (!current.success) return current;
	const merged = new Map(current.data);
	for (const l of changes.disable) merged.set(l, true);
	for (const l of changes.enable) merged.set(l, false);

	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await writeFile(tmp, encodeDisabledStore(merged), { mode: 0o644 });
		await chmod(tmp, 0o644);
		await rename(tmp, path);
		return ok({ path, entries: merged.size });
	} catch (e) {
		await rm(tmp, { force: true }).catch(() => undefined);
		return err(`cannot write ${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
}
