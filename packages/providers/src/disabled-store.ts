import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";

export const DEFAULT_DISABLED_STORE_ROOT = "/private/var/tmp";

const HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
`;
const FOOTER = "</dict>\n</plist>\n";

const ENTITIES: Readonly<Record<string, string>> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
};

/** Where the host-side store lives. */
export class DisabledStoreRoot {
	/** Directory holding `com.apple.CoreSimulator.SimDevice.<udid>/`; env override for tests. */
	resolve(env: Record<string, string | undefined> = process.env): string {
		const override = env.WARDEN_SIM_LAUNCHD_STORE_ROOT;
		return override ? override : DEFAULT_DISABLED_STORE_ROOT;
	}
}

export const disabledStoreRoot = new DisabledStoreRoot();

/** The plist dialect of `disabled.plist`: a flat `<key>label</key><true/|false/>` dict. */
export class DisabledStoreCodec {
	/** Flat `<key>label</key><true/|false/>` dict. Other value types and comments are skipped. */
	parse(xml: string): Map<string, boolean> {
		const out = new Map<string, boolean>();
		const body = xml.replace(/<!--[\s\S]*?-->/g, "");
		const re =
			/<key>([\s\S]*?)<\/key>\s*(?:<(true|false)\s*\/>|<(?:string|integer|real|date|data)\b[^>]*>[\s\S]*?<\/(?:string|integer|real|date|data)>|<(?:string|data)\s*\/>|<(?:array|dict)\b[^>]*>[\s\S]*?<\/(?:array|dict)>)/g;
		for (const m of body.matchAll(re)) {
			const [, key, bool] = m;
			if (key === undefined || bool === undefined) continue;
			out.set(this.decode(key), bool === "true");
		}
		return out;
	}

	encode(entries: ReadonlyMap<string, boolean>): string {
		const keys = [...entries.keys()].sort();
		let body = "";
		for (const k of keys) {
			body += `\t<key>${this.escape(k)}</key>\n\t<${entries.get(k) ? "true" : "false"}/>\n`;
		}
		return HEADER + body + FOOTER;
	}

	labels(entries: ReadonlyMap<string, boolean>): Set<string> {
		const out = new Set<string>();
		for (const [k, v] of entries) if (v) out.add(k);
		return out;
	}

	private decode(s: string): string {
		return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m);
	}

	private escape(s: string): string {
		return s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&apos;");
	}
}

export const disabledStoreCodec = new DisabledStoreCodec();

/** The host-side launchd override store of simulators, rooted at `root`. */
export class DisabledStore {
	constructor(private readonly root: string = disabledStoreRoot.resolve()) {}

	path(udid: string): string {
		return join(this.root, `com.apple.CoreSimulator.SimDevice.${udid}`, "disabled.plist");
	}

	/** Missing file means nothing disabled (never booted). Corrupt or unreadable is an error. */
	async read(udid: string): AsyncResult<Map<string, boolean>> {
		const path = this.path(udid);
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (e) {
			if (this.isNotFound(e)) return resultFactory.ok(new Map());
			return resultFactory.err(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (!text.includes("<plist") || !text.includes("<dict>")) {
			return resultFactory.err(`corrupt disabled store ${path}: not a plist dict`);
		}
		return resultFactory.ok(disabledStoreCodec.parse(text));
	}

	/** Merge into the host-side store: disable → true, enable → false, everything else untouched. */
	async write(
		udid: string,
		changes: { disable: readonly string[]; enable: readonly string[] }
	): AsyncResult<{ path: string; entries: number }> {
		const path = this.path(udid);
		const current = await this.read(udid);
		if (!current.success) return current;
		const merged = new Map(current.data);
		for (const l of changes.disable) merged.set(l, true);
		for (const l of changes.enable) merged.set(l, false);

		const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		try {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(tmp, disabledStoreCodec.encode(merged), { mode: 0o644 });
			await chmod(tmp, 0o644);
			await rename(tmp, path);
			return resultFactory.ok({ path, entries: merged.size });
		} catch (e) {
			await rm(tmp, { force: true }).catch(() => undefined);
			return resultFactory.err(`cannot write ${path}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private isNotFound(e: unknown): boolean {
		return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
	}
}
