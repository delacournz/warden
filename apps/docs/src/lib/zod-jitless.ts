import { config } from "zod";

/**
 * Tell zod to parse without compiling code. Zod decides this when a schema is
 * defined, and otherwise tries `new Function` once to see whether it may: the
 * site's content security policy (`http-cache.ts`) allows no string evaluation,
 * and a browser reports the attempt. The frontmatter schema is the only one
 * the site defines, so the slower path costs nothing a reader would notice.
 *
 * Import this before any module that defines a schema. It is imported for its
 * effect alone, so `package.json` lists it under `sideEffects`.
 */
config({ jitless: true });
