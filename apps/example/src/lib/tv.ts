import { createTV } from "tailwind-variants";
import { TW_MERGE_CONFIG } from "@/styles/tokens";

/**
 * `tailwind-variants`, taught the semantic size tokens from `tokens.css`.
 *
 * Import `tv` from here in every `*.variants.ts` — never from
 * `tailwind-variants` directly. `tv()` merges its own slots and variants
 * through a tailwind-merge instance it builds itself, entirely separate from
 * the one behind `cn()`, and a bare `tv` does not know what `button-md` is.
 *
 * That is not a cosmetic gap. An unrecognised `text-button-md` lands in
 * tailwind-merge's text *colour* group alongside `text-primary-foreground`, the
 * two are judged to conflict, and the label loses its colour — no error, just a
 * button whose text quietly renders in the wrong shade.
 *
 * Free of React Native imports so variants files stay unit-testable. See
 * AGENTS.md.
 */
export const tv = createTV({ twMergeConfig: TW_MERGE_CONFIG });
