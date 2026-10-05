import type { Ref } from "react";

type RefCleanup = () => void;

/**
 * Fans a single node out to several refs.
 *
 * React 19 lets a callback ref return a cleanup function. When any of the given
 * refs does, the composed ref returns a cleanup of its own that runs each child
 * cleanup and nulls out every object ref.
 */
export function composeRefs<T>(...refs: (Ref<T> | undefined)[]): (node: T | null) => RefCleanup | undefined {
	return (node) => {
		const cleanups: RefCleanup[] = [];

		for (const ref of refs) {
			if (!ref) continue;

			if (typeof ref === "function") {
				const result = ref(node);
				if (typeof result === "function") cleanups.push(result);
				continue;
			}

			ref.current = node;
		}

		if (cleanups.length === 0) return undefined;

		return () => {
			for (const cleanup of cleanups) cleanup();
			for (const ref of refs) {
				if (ref && typeof ref !== "function") ref.current = null;
			}
		};
	};
}
