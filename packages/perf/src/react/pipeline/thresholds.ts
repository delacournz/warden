/** One 60Hz frame: a commit under this fits the budget. */
export const FRAME_BUDGET_MS = 16;
/** Over this a commit is hot (a visible hitch); between the two it is warm. */
export const HOT_COMMIT_MS = 50;
/** A finding that costs less than this is noise. */
export const MIN_FINDING_COST_MS = 2;
/** A component finding must account for at least this share of all render time. */
export const MIN_RENDER_SHARE = 0.03;
/** Ranking: a component makes the list with this many renders, or one render this slow. */
export const RANK_MIN_RENDERS = 3;
export const RANK_MIN_MAX_MS = 30;
/** Render storm: this many commits inside the window. */
export const STORM_COMMITS = 10;
export const STORM_WINDOW_MS = 1000;
/** Effect chain: back-to-back commits (gap under this) triggered from effects, at least this long. */
export const CHAIN_GAP_MS = 32;
export const CHAIN_MIN_COMMITS = 3;
/** Eager mount: fibers mounted under one root in a single commit, and the cost that makes it matter. */
export const EAGER_MIN_FIBERS = 40;
export const EAGER_MIN_COST_MS = FRAME_BUDGET_MS;
/** Context cascade: consumers re-rendered by one context change. */
export const CASCADE_MIN_CONSUMERS = 5;
