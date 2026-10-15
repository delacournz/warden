import { describe, expect, test } from "bun:test";
import { ok } from "@delacour/warden-types/result";
import type { ReactTree, TreeComponent, TreeOptions } from "../devtools/devtools.types";
import { locateByTestIdViaReact } from "./react-locator";

const IOS = { platform: "ios" as const, screen: { width: 390, height: 844, scale: 3 } };
const ANDROID = { platform: "android" as const, screen: { width: 1080, height: 2400, scale: 2.5 } };

function facetOf(components: TreeComponent[], calls: (TreeOptions | undefined)[] = []) {
	return {
		tree: async (options?: TreeOptions) => {
			calls.push(options);
			const tree: ReactTree = { components, truncated: false };
			return ok(tree);
		},
	};
}

const comp = (id: number, testID: string | undefined, rect?: TreeComponent["rect"]): TreeComponent => ({
	id,
	name: "View",
	parent: null,
	...(testID === undefined ? {} : { testID }),
	...(rect === undefined ? {} : { rect }),
});

describe("locateByTestIdViaReact", () => {
	test("returns the frame and its centre", async () => {
		const facet = facetOf([
			comp(0, "pay", { x: 10, y: 20, width: 100, height: 40 }),
			comp(1, "other", { x: 0, y: 0, width: 5, height: 5 }),
		]);
		const matches = await locateByTestIdViaReact(facet, "pay", IOS);
		expect(matches).toEqual([
			{
				frame: { x: 10, y: 20, width: 100, height: 40 },
				tapPoint: { x: 60, y: 40 },
				source: "react",
				testId: "pay",
				name: "View",
			},
		]);
	});

	test("asks for pixels on Android: dp times the screen scale", async () => {
		const calls: (TreeOptions | undefined)[] = [];
		await locateByTestIdViaReact(facetOf([], calls), "pay", ANDROID);
		expect(calls[0]).toMatchObject({ pixelRatio: 2.5 });
		const ios: (TreeOptions | undefined)[] = [];
		await locateByTestIdViaReact(facetOf([], ios), "pay", IOS);
		expect(ios[0]?.pixelRatio).toBeUndefined();
	});

	test("passes the screen name through", async () => {
		const calls: (TreeOptions | undefined)[] = [];
		await locateByTestIdViaReact(facetOf([], calls), "pay", IOS, { screenName: "Settings" });
		expect(calls[0]).toMatchObject({ screen: "Settings" });
	});

	test("matches regexps like the accessibility query does", async () => {
		const box = { x: 0, y: 0, width: 2, height: 2 };
		const facet = facetOf([
			comp(0, "row-1", box),
			comp(1, "row-2", { ...box, y: 10 }),
			comp(2, "head", { ...box, y: 20 }),
		]);
		const matches = await locateByTestIdViaReact(facet, /^row-/, IOS);
		expect(matches.map((m) => m.testId)).toEqual(["row-1", "row-2"]);
	});

	test("skips components without a rect (nothing to tap)", async () => {
		const matches = await locateByTestIdViaReact(facetOf([comp(0, "pay")]), "pay", IOS);
		expect(matches).toEqual([]);
	});

	test("a failing tree is no match, not a throw", async () => {
		const facet = {
			tree: async () => ({
				success: false as const,
				error: { code: "devtools_unavailable" as const, message: "no hook" },
			}),
		};
		expect(await locateByTestIdViaReact(facet, "pay", IOS)).toEqual([]);
	});

	test("a throwing tree is no match too", async () => {
		const facet = {
			tree: async (): Promise<never> => {
				throw new Error("socket");
			},
		};
		expect(await locateByTestIdViaReact(facet, "pay", IOS)).toEqual([]);
	});
});
