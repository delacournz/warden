import { describe, expect, test } from "bun:test";
import { resolveSources, type SourceDeps } from "./react-source";

const project: Record<string, string> = {
	"/p/src/Feed.tsx":
		"export function FeedList() { return null }\nexport const FeedRow = memo(() => null);\nconst FeedRow2 = 1;",
	"/p/src/Avatar.tsx": "// nothing\nexport const Avatar = () => null;",
	"/p/src/zz.ts": "function FeedList() {}",
};
const reads: string[] = [];
const deps: SourceDeps = {
	files: () => Object.keys(project),
	read: (p) => {
		reads.push(p);
		return project[p];
	},
};

describe("resolveSources", () => {
	test("device _debugSource wins and is made project-relative", () => {
		const got = resolveSources(["FeedList"], "/p", { FeedList: { file: "/p/src/other/FeedList.tsx", line: 9 } }, deps);
		expect(got.get("FeedList")).toEqual({ file: "src/other/FeedList.tsx", line: 9 });
	});

	test("greps the project for the rest, one pass, stops once all are found", () => {
		reads.length = 0;
		const got = resolveSources(["FeedRow", "Avatar", "Memo(FeedList)"], "/p", {}, deps);
		expect(got.get("FeedRow")).toEqual({ file: "src/Feed.tsx", line: 2 });
		expect(got.get("Avatar")).toEqual({ file: "src/Avatar.tsx", line: 2 });
		expect(got.get("Memo(FeedList)")).toEqual({ file: "src/Feed.tsx", line: 1 });
		expect(reads).toEqual(["/p/src/Feed.tsx", "/p/src/Avatar.tsx"]);
	});

	test("names that cannot be a declaration, or are not in the project, are absent", () => {
		const got = resolveSources(["Context.Consumer", "Unknown#3", "Missing"], "/p", {}, deps);
		expect(got.size).toBe(0);
	});
});
