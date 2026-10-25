/// <reference path="./sql.d.ts" />

import { PACKAGE_NAME } from "./perfetto.config";
import cpuHotspots from "./queries/cpu-hotspots.sql" with { type: "text" };
import hangFoldsBatched from "./queries/hang-folds-batched.sql" with { type: "text" };
import memoryRss from "./queries/memory-rss.sql" with { type: "text" };
import threadBreakdown from "./queries/thread-breakdown.sql" with { type: "text" };
import uiHangs from "./queries/ui-hangs.sql" with { type: "text" };

/** PerfettoSQL for `trace_processor_shell --query-file`; the last SELECT of each file is its result. */
export const QUERIES = {
	"cpu-hotspots": cpuHotspots,
	"ui-hangs": uiHangs,
	"hang-folds-batched": hangFoldsBatched,
	"thread-breakdown": threadBreakdown,
	"memory-rss": memoryRss,
} as const;

export type QueryName = keyof typeof QUERIES;

/** The query with `{{PACKAGE}}` filled in; undefined for a package that is not a plain Android package name (it lands in SQL). */
export function renderQuery(name: QueryName, packageName: string): string | undefined {
	if (!PACKAGE_NAME.test(packageName)) return undefined;
	return QUERIES[name].replaceAll("{{PACKAGE}}", packageName);
}
