/** `warden pods prune` / `warden gc`: pods entries unused this long go. */
export const DEFAULT_PODS_MAX_AGE = "30d";

/** `warden pods prune`: the cache is trimmed (least recently used first) to this apparent size. */
export const DEFAULT_PODS_MAX_SIZE = "10G";
