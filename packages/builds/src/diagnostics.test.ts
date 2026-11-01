import { describe, expect, test } from "bun:test";
import { formatBuildFailure, parseBuildDiagnostics } from "./diagnostics";

/** Shape of real `swiftc` / `xcodebuild` output (Xcode 27.1): path:line:col diagnostics, source excerpts, a summary repeat. */
const OUTPUT = `CompileSwift normal arm64 /Users/x/app/ios/App/Bad.swift (in target 'App' from project 'App')
/Users/x/app/ios/App/Bad.swift:2:14: error: cannot convert value of type 'String' to specified type 'Int'
1 | import Foundation
2 | let x: Int = "a"
  |              \`- error: cannot convert value of type 'String' to specified type 'Int'
3 | func f() { undefinedThing() }

/Users/x/app/ios/App/Bad.swift:3:12: error: cannot find 'undefinedThing' in scope
/Users/x/app/ios/App/Other.swift:9:1: warning: variable 'y' was never used
ld: symbol(s) not found for architecture arm64
clang: error: linker command failed with exit code 1 (use -v to see invocation)
error: Signing for "App" requires a development team.

** BUILD FAILED **


The following build commands failed:
\tCompileSwift normal arm64 /Users/x/app/ios/App/Bad.swift (in target 'App' from project 'App')
/Users/x/app/ios/App/Bad.swift:2:14: error: cannot convert value of type 'String' to specified type 'Int'
`;

describe("parseBuildDiagnostics", () => {
	test("file:line:col errors, file-less errors, deduplicated, warnings dropped", () => {
		expect(parseBuildDiagnostics(OUTPUT)).toEqual([
			{
				file: "/Users/x/app/ios/App/Bad.swift",
				line: 2,
				column: 14,
				message: "cannot convert value of type 'String' to specified type 'Int'",
			},
			{ file: "/Users/x/app/ios/App/Bad.swift", line: 3, column: 12, message: "cannot find 'undefinedThing' in scope" },
			{ message: "linker command failed with exit code 1 (use -v to see invocation)" },
			{ message: 'Signing for "App" requires a development team.' },
		]);
	});
	test("nothing recognisable is an empty list", () => {
		expect(parseBuildDiagnostics("all fine\n")).toEqual([]);
	});
});

describe("formatBuildFailure", () => {
	const diags = parseBuildDiagnostics(OUTPUT);
	test("headline of the first errors with file:line, count, log path", () => {
		const text = formatBuildFailure(diags, "/h/logs/build.log", 2);
		expect(text).toContain("4 errors");
		expect(text).toContain("/Users/x/app/ios/App/Bad.swift:2:14: cannot convert value");
		expect(text).toContain("/Users/x/app/ios/App/Bad.swift:3:12");
		expect(text).toContain("+2 more");
		expect(text).toContain("/h/logs/build.log");
	});
	test("no diagnostics: undefined so the caller keeps its own message", () => {
		expect(formatBuildFailure([], "/log")).toBeUndefined();
	});
});
