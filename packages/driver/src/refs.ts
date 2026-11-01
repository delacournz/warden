import type { Result } from "@delacour/warden-types/result";
import type { DriverError, Element, Snapshot } from "./driver.types";
import { driverError } from "./errors";

/**
 * Short, per-snapshot handles for elements: `@e1`, `@e2`, … in preorder over `Snapshot.flat`.
 * A ref is only valid for the snapshot generation that issued it; a newer snapshot bumps the
 * generation and old refs resolve to `E_STALE_REF` so callers re-snapshot instead of tapping a
 * stale frame.
 */
export type RefTable = {
	generation: number;
	/** `@e1` → element */
	byRef: ReadonlyMap<string, Element>;
	/** `Element.id` → `@e1` */
	byId: ReadonlyMap<string, string>;
};

const REF_PATTERN = /^@e[1-9]\d*$/;

export function isRef(value: string): boolean {
	return REF_PATTERN.test(value);
}

/** Assign `@e1…` in the preorder of `snapshot.flat`. */
export function assignRefs(snapshot: Pick<Snapshot, "flat">, generation: number): RefTable {
	const byRef = new Map<string, Element>();
	const byId = new Map<string, string>();
	snapshot.flat.forEach((element, index) => {
		const ref = `@e${index + 1}`;
		byRef.set(ref, element);
		byId.set(element.id, ref);
	});
	return { generation, byRef, byId };
}

/** `E_STALE_REF` when the table is from another generation, `E_NO_ELEMENT` for an unknown/malformed ref. */
export function resolveRef(table: RefTable, ref: string, currentGeneration: number): Result<Element, DriverError> {
	if (table.generation !== currentGeneration) {
		return {
			success: false,
			error: driverError(
				"E_STALE_REF",
				`ref ${ref} is from snapshot generation ${table.generation}, current is ${currentGeneration}; take a new snapshot`,
				{ detail: { ref, refGeneration: table.generation, currentGeneration } }
			),
		};
	}
	const element = table.byRef.get(ref);
	if (!element) {
		const message = isRef(ref)
			? `no element ${ref} in this snapshot (${table.byRef.size} refs)`
			: `malformed ref ${ref}`;
		return { success: false, error: driverError("E_NO_ELEMENT", message, { detail: { ref } }) };
	}
	return { success: true, data: element };
}

/** The ref for an element of the table's snapshot, if it is part of it. */
export function refFor(table: RefTable, element: Pick<Element, "id">): string | undefined {
	return table.byId.get(element.id);
}
