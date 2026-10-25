import { useDocsSearch } from "fumadocs-core/search/client";
import { fetchClient } from "fumadocs-core/search/client/fetch";
import {
	SearchDialog,
	SearchDialogClose,
	SearchDialogContent,
	SearchDialogHeader,
	SearchDialogIcon,
	SearchDialogInput,
	SearchDialogList,
	SearchDialogOverlay,
	type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import { type ReactElement, useEffect, useMemo, useRef } from "react";
import { track } from "@/lib/analytics/track";

/** How long the reader stops typing before a query counts as one search. */
const SETTLE_MS = 800;
const MIN_QUERY = 2;

/**
 * Fumadocs' default search dialog, rebuilt from its own parts so the query is
 * in reach: the default keeps it in internal state, and passing
 * `onSearchChange` through its props replaces its setter rather than
 * observing it.
 *
 * One `search` event per query the reader settles on, not per keystroke: the
 * dialog already queries as they type, and "c", "cl", "cla" are not three
 * searches. It carries the query text and how many pages matched, so a query
 * that finds nothing is the one worth reading.
 */
export function TrackedSearchDialog(props: SharedProps): ReactElement {
	const client = useMemo(() => fetchClient(), []);
	const { search, setSearch, query } = useDocsSearch({ client });
	const sent = useRef("");

	useEffect(() => {
		const text = search.trim();
		if (query.isLoading || text.length < MIN_QUERY || text === sent.current) return;

		const results = query.data === "empty" || !query.data ? 0 : query.data.filter((r) => r.type === "page").length;
		const timer = setTimeout(() => {
			sent.current = text;
			track({ name: "search", query: text, results });
		}, SETTLE_MS);

		return () => clearTimeout(timer);
	}, [search, query.isLoading, query.data]);

	return (
		<SearchDialog isLoading={query.isLoading} onSearchChange={setSearch} search={search} {...props}>
			<SearchDialogOverlay />
			<SearchDialogContent>
				<SearchDialogHeader>
					<SearchDialogIcon />
					<SearchDialogInput />
					<SearchDialogClose />
				</SearchDialogHeader>
				<SearchDialogList items={query.data !== "empty" ? query.data : null} />
			</SearchDialogContent>
		</SearchDialog>
	);
}
