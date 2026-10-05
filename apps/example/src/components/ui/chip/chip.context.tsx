import { createContext, type ReactElement, type ReactNode, use } from "react";
import type { ChipColor, ChipSize, ChipVariant } from "./chip.variants";

export type ChipContextValue = {
	/** Size of the chip. */
	size: ChipSize;
	/** How the chip is painted while unselected. */
	variant: ChipVariant;
	/** What the chip means. */
	color: ChipColor;
	/** Whether the chip is selected. Always `false` for a chip that cannot be. */
	isSelected: boolean;
	/** Whether the chip is disabled. */
	isDisabled: boolean;
};

const ChipContext = createContext<ChipContextValue | null>(null);

/**
 * Supplies the enclosing chip's variant, colour, size and state to its subtree.
 *
 * Lives in its own module, importing nothing but `chip.variants`, so a part can
 * read it without importing `./chip`. That import would close a cycle, and Metro
 * serves a partially initialised module for a cycle — leaving the context
 * `undefined` at import time and red-boxing the app on a cold start.
 */
export function ChipProvider({ value, children }: { value: ChipContextValue; children: ReactNode }): ReactElement {
	return <ChipContext value={value}>{children}</ChipContext>;
}
ChipProvider.displayName = "DelacourUI.Chip.Provider";

/** The enclosing chip's context, or null outside a `<Chip>`. */
export function useChipContext(): ChipContextValue | null {
	return use(ChipContext);
}

/**
 * Reads the enclosing chip's variant, colour, size and state.
 *
 * Lets a custom child restyle itself when the chip is selected without the chip
 * passing props down through every slot. Throws outside a `<Chip>` — use
 * {@link useChipContext} where the enclosing chip is optional.
 */
export function useChip(): ChipContextValue {
	const context = useChipContext();
	if (!context) {
		throw new Error("useChip must be called inside a <Chip>.");
	}
	return context;
}

/**
 * The enclosing chip's context, for a compound part that cannot work without
 * one.
 *
 * Internal: deliberately not re-exported from `index.ts`. A caller outside the
 * library wants {@link useChip}, whose error message names the hook rather than
 * a part.
 */
export function useChipPart(component: string): ChipContextValue {
	const context = useChipContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <Chip>.`);
	}
	return context;
}
