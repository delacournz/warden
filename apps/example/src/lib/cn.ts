import type { ClassValue } from "cn";
import { createCn } from "cn/config";
import { TW_MERGE_CONFIG } from "@/styles/tokens";

/**
 * Class joining and conflict resolution, taught the semantic size tokens from `tokens.css`.
 *
 * Built on `cn` (shadcn-ui/cn), which replaces `clsx` + `tailwind-merge` with one
 * engine: the same join semantics, the same merge output, and much cheaper on the
 * repeated calls a render loop makes. `createCn` takes tailwind-merge's own
 * `{ extend }` shape, so `TW_MERGE_CONFIG` is passed unchanged.
 *
 * Registering the tokens is load-bearing rather than tidiness. The merger only
 * treats two classes as conflicting when it recognises both as members of the
 * same group, and `button-md` is not a value it knows. Left unregistered,
 * `cn("h-button-md", "h-12")` returns *both* classes: they each resolve to a
 * height, uniwind applies whichever it saw last, and a caller's override works
 * or does not depending on class order. Nothing throws, so the failure is
 * silent — which is why every token here must be asserted.
 *
 * `tv()` needs the same treatment for its own merger — see `lib/tv.ts`.
 */
const merge = createCn(TW_MERGE_CONFIG);

/**
 * Merges class names and resolves Tailwind conflicts so the last utility wins.
 *
 * Uniwind does not deduplicate conflicting classes on its own — both would be
 * applied and the winner would be undefined. Always route a caller-supplied
 * `className` through this before handing it to a component.
 */
export function cn(...inputs: ClassValue[]): string {
	return merge(...inputs);
}
