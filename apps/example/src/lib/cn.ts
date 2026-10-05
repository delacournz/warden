import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { type CustomClassGroupId, TW_MERGE_CONFIG } from "@/styles/tokens";

/**
 * tailwind-merge, taught the semantic size tokens from `tokens.css`.
 *
 * Registering them is load-bearing rather than tidiness. tailwind-merge only
 * treats two classes as conflicting when it recognises both as members of the
 * same group, and `button-md` is not a value it knows. Left unregistered,
 * `cn("h-button-md", "h-12")` returns *both* classes: they each resolve to a
 * height, uniwind applies whichever it saw last, and a caller's override works
 * or does not depending on class order. Nothing throws, so the failure is
 * silent — which is why `cn.test.ts` asserts every token here.
 *
 * `tv()` needs the same treatment for its own merger — see `lib/tv.ts`.
 */
const twMerge = extendTailwindMerge<CustomClassGroupId>(TW_MERGE_CONFIG);

/**
 * Merges class names and resolves Tailwind conflicts so the last utility wins.
 *
 * Uniwind does not deduplicate conflicting classes on its own — both would be
 * applied and the winner would be undefined. Always route a caller-supplied
 * `className` through this before handing it to a component.
 */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
