import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CANONICAL_IDS, type CanonicalId, canonicalIdSchema, frameworkIdSchema } from "./schema";

export const manifestSchema = z.object({
	$comment: z.string().optional(),
	tests: z.record(
		canonicalIdSchema,
		z.object({
			title: z.string(),
			steps: z.array(z.string()),
			native: z.record(frameworkIdSchema, z.string()),
		})
	),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type FrameworkKey = z.infer<typeof frameworkIdSchema>;

export function parseManifest(text: string): { success: true; data: Manifest } | { success: false; error: string } {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (e) {
		return { success: false, error: `manifest is not JSON: ${e instanceof Error ? e.message : String(e)}` };
	}
	const parsed = manifestSchema.safeParse(json);
	if (!parsed.success)
		return { success: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
	const missing = CANONICAL_IDS.filter((id) => parsed.data.tests[id] === undefined);
	if (missing.length > 0) return { success: false, error: `manifest is missing ${missing.join(", ")}` };
	return { success: true, data: parsed.data };
}

/** `suites/manifest.json` of the package; throws when it is unreadable (a programming error). */
export function loadManifest(packageRoot: string): Manifest {
	const parsed = parseManifest(readFileSync(join(packageRoot, "suites/manifest.json"), "utf8"));
	if (!parsed.success) throw new Error(parsed.error);
	return parsed.data;
}

/** native name → canonical id for one framework. */
export function nativeIndex(manifest: Manifest, framework: FrameworkKey): Map<string, CanonicalId> {
	const index = new Map<string, CanonicalId>();
	for (const id of CANONICAL_IDS) {
		const native = manifest.tests[id]?.native[framework];
		if (native !== undefined) index.set(native, id);
	}
	return index;
}

/**
 * Joins a framework's native results on the manifest: every canonical id gets a result (`missing` when
 * the framework printed none), and an unmapped native name is reported (a parity breach).
 */
export function joinNative<T extends { nativeName: string }>(
	manifest: Manifest,
	framework: FrameworkKey,
	native: readonly T[],
	toResult: (id: CanonicalId, t: T) => { id: CanonicalId; nativeName: string; status: string }
): {
	mapped: Array<ReturnType<typeof toResult> | { id: CanonicalId; nativeName: string; status: "missing" }>;
	unmapped: string[];
} {
	const index = nativeIndex(manifest, framework);
	const byId = new Map<CanonicalId, T>();
	const unmapped: string[] = [];
	for (const t of native) {
		const id = index.get(t.nativeName);
		if (id === undefined) unmapped.push(t.nativeName);
		else byId.set(id, t);
	}
	const mapped = CANONICAL_IDS.map((id) => {
		const t = byId.get(id);
		if (t === undefined)
			return { id, nativeName: manifest.tests[id]?.native[framework] ?? id, status: "missing" as const };
		return toResult(id, t);
	});
	return { mapped, unmapped };
}
